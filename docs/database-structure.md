# Database structure

PostgreSQL, 32 tables, created by 18 numbered scripts in `apps/server/src/db/` (`001_init.sql` ... `018_hub_poll.sql`). They run
automatically every time the server starts and can be run again safely. The exact definitions are in those files; this page is the map.

Conventions used everywhere:
- **Money is whole cents** (`bigint`), never decimals.
- Nearly every table has a **`merchant_id`**, so one database can hold several merchants. Today there is one: `bailey-patch`.
- Anything that moves money, points or print jobs has an **idempotency / dedupe key**, so a retry never counts twice.
- Secrets (PINs, device and session tokens, sign-in codes) are stored **hashed**, never in plain text.

## 1. Menu and prices (what you manage on the Prices screen)

| Table | What it holds | Key columns |
|---|---|---|
| `products` | Every item | `id`, `name`, `category`, `description`, `alt_name`, `sold_out`, `points_exempt`, `options` (JSON: size and add-on groups), `image_version`, `sort` |
| `product_images` | The item's photo | `product_id`, `bytes`, `type`, `version` |
| `pricebooks` | A named set of prices | `id`, `name`, `missing` (what to do with items that have no price here: use the default book, or hide) |
| `pricebook_prices` | One price for one item in one pricebook | `pricebook_id`, `product_id`, `price_cents` |
| `channels` | How an order is made: Dine in, Take away, delivery | `id`, `name`, `kind`, `service_charge`, `active`, `sort` |
| `pricebook_assignments` | Which pricebook a channel (and/or outlet) uses | `pricebook_id`, `channel_id`, `outlet_id` |
| `catalog_meta` | The default pricebook, and a version number that goes up on every change so devices know to refresh | `default_pricebook_id`, `version` |
| `merchant_brand` | The shop's look: colours, logo, hero image, tagline, promo text | `primary_color`, `accent_color`, `logo`, `hero`, `tagline`, `promo_title`, `promo_body` |

How they connect: a product has one price per pricebook; a channel points at a pricebook; the order screen shows the prices of the
pricebook for the channel the customer chose (Dine in and Take away can differ).

## 2. Orders (the event log)

There is **no "orders" table**. An order is the sum of what happened to it.

| Table | What it holds | Key columns |
|---|---|---|
| `events` | Every order event, in order: opened, item added, accepted, paid, stage changed, cancelled | `server_seq` (the order of events), `id` (unique, so a repeat is ignored), `order_id`, `device_id`, `type`, `body` (JSON) |
| `counters` | Daily counters, such as queue numbers | `name`, `day`, `value` |

The current state of any order (items, totals, payments, status) is worked out by replaying its events. This is what lets tills work
offline and sync later without conflicts, and it keeps a full history of every change.

## 3. Members, points, coupons, stamps (the customer accounts)

| Table | What it holds | Key columns |
|---|---|---|
| `members` | A customer account | `id`, `email` (can be empty for phone sign-ups), `name`, `phone`, `points_balance`, `pref_order_updates`, `pref_promos` |
| `points_entries` | The points ledger: every earn, spend, welcome bonus and manual adjustment | `member_id`, `kind`, `points`, `balance_after`, `idempotency_key`, `order_id`, `note` |
| `member_orders` | Links a member to an order, and what points it used and earned | `order_id`, `member_id`, `points_redeemed`, `earned_points`, `stamped` |
| `member_coupons` | Coupons and vouchers a member holds | `title`, `amount_cents`, `min_spend_cents`, `expires_at`, `used_order_id` |
| `member_stamps` | The stamp card | `count`, `cards_completed` |
| `member_identities` | Which Google, Microsoft or phone login belongs to which member | `provider`, `subject`, `member_id` |
| `member_sessions` | Signed-in sessions | `token_hash`, `expires_at` |
| `member_challenges` | Emailed sign-in codes | `code_hash`, `expires_at`, `attempts`, `used` |
| `login_tickets`, `oauth_states`, `sms_challenges` | Short-lived records used during Google, Microsoft and phone sign-in | |
| `member_notices` | Remembers which "your order is ready" emails were sent, so none goes twice | `order_id`, `kind` |

## 4. Prepaid credit (money a customer tops up)

| Table | What it holds | Key columns |
|---|---|---|
| `wallets` | One balance per customer (the customer id is the member's id) | `customer_id`, `balance_cents` (never below zero) |
| `ledger_entries` | Every top-up, spend, refund and adjustment | `wallet_id`, `kind`, `amount_cents`, `balance_after`, `idempotency_key`, `order_id`, `staff_id`, `device_id`, `note` |

## 5. Printing

| Table | What it holds | Key columns |
|---|---|---|
| `printers` | The shop's printers | `id`, `name`, `language` (ESC/POS, ZPL, EPL), `roles` (receipt, kitchen, label), `categories` (which menu categories it prints), `connection` (address and port), `raster`, `drawer`, `width_chars`, `agent_device_id`, `active` |
| `print_jobs` | The print queue. Each job is stored as the exact bytes to send | `printer_id`, `doc_type`, `order_id`, `payload`, `status` (queued, leased, done, failed, unconfirmed), `attempts`, `next_attempt_at`, `last_error`, `dedupe_key` |
| `printed_lines` | Which order lines were already printed, so an added item prints alone | `order_id`, `line_id`, `doc_type` |

## 6. Staff, devices and audit

| Table | What it holds | Key columns |
|---|---|---|
| `staff` | Staff logins | `code`, `name`, `role` (cashier, manager, owner), `pin_hash`, `failed_attempts`, `locked_until` |
| `sessions` | Staff sign-ins | `token_hash`, `staff_id`, `expires_at` |
| `devices` | Every enrolled tablet, till, browser and print hub | `name`, `token_hash`, `active`, `last_seen_at`, `last_print_poll_at` (when a print hub last checked in) |
| `enrollment_codes` | One-time codes for linking a new device | `code_hash`, `expires_at`, `used_at` |
| `audit_log` | Who did what: top-ups, price changes, manual points, device changes | `staff_id`, `action`, `detail` (JSON), `created_at` |

## Main relationships

```
products ──< pricebook_prices >── pricebooks ──< pricebook_assignments >── channels
products ── product_images

members ──< points_entries          members ──< member_coupons
members ──< member_orders >── (events: order_id)       members ── member_stamps
members ──< member_sessions         members ──< member_identities
members.id = wallets.customer_id ──< ledger_entries

printers ──< print_jobs >── (events: order_id)
devices ──< enrollment_codes        staff ──< sessions        staff ──< audit_log
```

# POS

Offline-first point-of-sale. One order engine, configurable per business:

| Mode (`paymentTiming`) | Behaviour |
|---|---|
| `prepay` (fast serve) | Pay first -> queue number -> kitchen sees the order once paid |
| `postpay` (restaurant) | Order goes to the kitchen straight away, bill stays open, settle later |
| `deferred` (delivery) | Order now, pay later (delivery workflow not built yet) |

## Layout
- `packages/core` – pure logic, no I/O: price engine (cents), business config presets,
  order event log + reducer, offline-safe queue numbers. 30 tests.
- `apps/server` – Fastify. Event log in Postgres when `DATABASE_URL` is set (JSON file otherwise),
  `/api/sync/push`, `/api/sync/pull`, `/api/stream` (SSE), and the prepaid credit ledger
  (`/api/wallet/*`, Postgres only). `npm test -w @pos/server` starts a throwaway real Postgres
  via `embedded-postgres` – no Docker or system install needed.
- `apps/web` – React PWA. IndexedDB local store, background sync, POS / Kitchen / Queue screens.

## Run
```bash
npm install
npm test                      # core tests
npm run dev:server            # http://localhost:8787  (POS_MODE=fastServe|restaurant|delivery)
npm run dev:web               # http://localhost:5173
```
Screens: `#/pos`, `#/kitchen`, `#/queue` (public display).

## How offline works
Every action is an event written to the device's IndexedDB first. A sync loop pushes unsynced
events and pulls new ones (on reconnect, on server nudges, and every 8s). Events have
device-generated ids, so replays are idempotent and two offline tablets merge cleanly.
Queue numbers are per device (`A001`, `B001`) so they can never collide offline.
Online payments are recorded as *unconfirmed* and only count once the gateway confirms.

## Try everything locally (full mode, with a real database)
Four terminals, no Docker or Postgres install needed:

    npm install
    npm run dev:db                                              # 1. PostgreSQL (data kept in apps/server/data/pg)
    npm run cli -- create-staff OWN "Your Name" owner 123456    # 2. once: the first owner (staff code OWN, PIN 123456)
    npm run cli -- enrollment-code                              #    prints a one-time code for your first device
    npm run dev:server:pg                                       # 3. the server on :8787
    npm run dev:web                                             # 4. the app on :5173

Open http://localhost:5173/#/pos in Chrome, enter the code, then sign in (top right). More devices (kitchen, queue
display) enrol with codes from **Devices**; use a private window per device, because each keeps its own storage.
The customer page is http://localhost:5173/#/shop (works in any window, no enrolment). To start fresh, stop
everything and delete `apps/server/data/pg`. `npm run dev:server` + `npm run dev:web` without a database still runs
the till, kitchen and queue offline-first, but without sign-in, credit, catalog editing, printing or the shop.

## Staff accounts (needs `DATABASE_URL`)
Credit routes require a staff sign-in (code + PIN, locks for 5 min after 5 wrong PINs, 12 h sessions).
Create the first owner from the terminal, then add others through `POST /api/staff`:

    DATABASE_URL=... npx tsx apps/server/src/cli.ts create-staff OWN "Owner Name" owner 123456

Roles: **cashier** (top up up to S$200 at a time, take credit payments), **manager** (also refunds, audit log),
**owner** (also creates staff). Every top-up, spend and refund is stamped with the staff member; top-ups,
refunds, logins and staff changes go to `audit_log` (`GET /api/audit`).
Taking orders does not need a staff sign-in (it has to work offline), but the device must be enrolled.

## Device enrollment (needs `DATABASE_URL`)
Every till, kitchen screen, queue display and hub must be enrolled before it can sync, sign staff in, or touch
credit. Enrolling trades a one-time code (8 characters, 15 minutes, single use) for a long-lived device token;
only hashes are stored. The very first code comes from the terminal:

    DATABASE_URL=... npx tsx apps/server/src/cli.ts enrollment-code

After that a manager or owner makes codes under **Devices** on an enrolled device, and can remove a lost one
(it stops syncing immediately; orders already queued on it are kept). **Re-enrol** reissues access to the same
device id, so its queued offline orders are still accepted. A device can only push events carrying its own id.
The live stream uses a 30-second one-time ticket instead of the token (EventSource cannot send headers).
Without `DATABASE_URL` (plain local development) enrollment is off and sync stays open.

## Channels and pricebooks
A **channel** is a dining/fulfilment option (Dine in, Take away, Grab, Movie Event…): editable name, a kind,
and whether service charge applies. A **pricebook** is a price list. The pricebook for an outlet +
channel is the first hit of: pricebook assigned to *outlet and channel* → to the *channel* → to the *outlet* →
the merchant's *default*. **Only that one pricebook is used**: an item with no price in it cannot be ordered there
and no other pricebook's price is ever substituted (spec A-1). The pricebook's setting decides whether such an item
is hidden or shown but blocked. Resolution is one pure function in `packages/core/src/catalog.ts`, run on the device from a
cached copy of the whole catalog, so every channel prices correctly offline. Orders freeze the channel and the
price when placed; later price changes never touch them.
Managers/owners change prices, channels, assignments and items on the **Prices** screen (or `/api/catalog/*`);
every change is validated as a whole, versioned, and audited with the old and new value.
Sample data (`apps/server/src/catalogSeed.ts`): the Grab uplift (+15%, rounded up to 5c) is invented for the demo.

## Printing (needs `DATABASE_URL`)
`packages/core/src/print/`: a printer-agnostic document model, a receipt, a kitchen ticket and an item label,
and three encoders: **ESC/POS** (receipt and kitchen printers, 32/42/48 columns, QR, Code 128, cash drawer, cut),
**ZPL II** and **EPL2** (Zebra label printers, laid out in mm so one layout fits 203 or 300 dpi). In the printer's own
text mode, text is folded to ASCII (see `toAscii`): Chinese, Tamil and other scripts print as `?`. Turn on **Print as a
picture** for a receipt/kitchen printer (`raster`) and the ticket is drawn as a bitmap (`GS v 0`, sent in bands) so every
script and logo prints the same on any ESC/POS printer (spec C-1). Fonts come from the server machine
(`@napi-rs/canvas`): on a Linux server install Noto Sans CJK and Noto Sans Tamil, or set `PRINT_FONT_DIR` to a folder of
fonts. Long item names wrap rather than being cut. QR codes, the cash drawer and the cutter stay native commands.
Star-compatible raster mode is not built (the Star command set differs).
`apps/server/src/print.ts`: printers (Manager screen/API: `PUT /api/printers/:id`) and a durable queue. When an
order's events arrive the server queues what is now printable: the kitchen ticket (fast serve: once paid;
restaurant: immediately), the receipt once fully paid (cash opens the drawer), a label per unit. Later additions
to an open tab print as an **ADD-ON** with only the new items. A printer can take only some menu categories
(a bar printer for Drinks). Jobs are stored as final printer bytes, leased to a delivery agent, retried with
growing delays (5 s, 15 s, 45 s, 2 min) up to 5 attempts, then marked failed for a manager to retry. When delivery is
ambiguous (the connection was made and then broke, or the agent died mid-print) the job is parked as **unconfirmed**
and is never printed again on its own: a person looks at the printer and presses Reprint. `apps/server/src/printAgent.ts` (run `POS_URL=… DEVICE_TOKEN=… npx tsx
apps/server/src/agent.ts`) delivers jobs to printers' raw TCP port 9100 and is the reference for the hub app.
A raw TCP write proves the bytes reached the printer, not that paper came out (no out-of-paper detection yet).
Screens: **Printers** (managers/owners) adds and edits printers, sends a test page, shows recent jobs and retries
failed ones, with a red count on the nav link when something failed for good. **Orders** (any signed-in staff)
lists recent orders with Receipt / Kitchen ticket reprint buttons.

## Customer ordering (needs `DATABASE_URL`)
Public page at `/#/shop` (add `?table=Table%205` for a table QR code, `?channel=grab` to preselect a channel): no
sign-in, no device enrolment. It uses the catalog, so each channel shows its own prices, and it dresses itself in the
merchant's colours and logo (set under **Prices → Shop look**; PNG/JPEG/WebP up to 300 KB, SVG refused).
The customer's device sends only product ids and quantities; **the server prices the order** (`quoteOrder`, shared
with the page's live total), and tells the customer if prices moved before placing anything. Orders get a collection number
from the phone (last 5 digits, `81234`; a clash with an active order becomes `81234A`, `81234B`, and a completed order
frees its number); with no phone they get `W001…` (daily). Orders are **held until staff accept them** on the **Online** screen, so a stranger cannot send tickets
to the kitchen; in fast serve the kitchen then waits for payment as usual. Payment is at the counter (cash or the
customer's credit); there is no online payment. The customer's status page polls every 4 s: sent → accepted/please
pay → in the queue → being prepared → ready → collected (or cancelled). Limits per address: 10 orders / 10 min.
The page follows the prototype: greeting and table pill, logo, outlet, Dine in / Take away, the café photo with its
tagline, an optional special offer, a category rail with search, photo cards (with price ranges), a customise screen
for items with options, and the red "View bag" bar. The 132-item Bailey & Patch menu is the starting data
(`apps/server/seed/bailey-patch`, see its README for what was and was not imported).
Items can have **Variants** (the item's own variation: Hot/Iced, Small/Big; each is its own line, the card shows the
lower price) and **options** (add-ons: protein, extras; choose a protein, extras at +S$2.00 each): the same item with different
choices is a different line, the server prices them, and tickets, receipts, labels and the Online screen show them.
The till asks the same questions. Managers edit prices, photos, the tagline, the offer, colours and logo on **Prices**
(editing options themselves is API-only for now: `POST /api/catalog/products` with `options`).
Set `TRUST_PROXY=1` behind a reverse proxy, or every customer looks like one address.

## Customer accounts and points (needs `DATABASE_URL`)
Customers sign in on the shop page with an emailed 6-digit code (single use, 10 minutes, 5 tries); a new email becomes
a member and gets the welcome points once (500, a merchant setting). With email set up (below) the code is emailed and
never returned to the page. Without it the code is written to the server log and, outside `NODE_ENV=production`, returned to the page so it can be tested. **Set `NODE_ENV=production` on a live deployment.** Google,
Microsoft and phone sign-in, and card / PayNow payment, are built but switched on by settings (next section). Guests can still order; they just cannot use points.
Points are an append-only ledger (`points_entries`, with the balance kept in the same transaction, same idempotent
pattern as credit). Rates are settings in `config.rewards` (`earnPointsPerDollar` default 1, `welcomePoints` 500,
`pointsEnabled`); redeeming is 100 points = S$1. Spending happens when the order is placed (and is frozen on the order
as a `PointsRedeemed` event), earning happens once the order is fully paid (on what was actually paid), and a
cancelled order gives the spent points back.
**Coupons and vouchers** live in a per-member wallet (`member_coupons`). A new member gets the S$2 welcome voucher once
(`config.rewards.welcomeVoucherCents`, no minimum spend). A coupon's minimum spend is checked on the **items subtotal
only** (before service charge, tax and deposits); the bag shows "Add S$x more in items" for one that doesn't qualify yet.
A coupon is used atomically (two orders cannot share it), is frozen on the order as a `CouponApplied` event, works
together with points, and is released again if the order is cancelled. **Stamp cards** (`config.rewards.stampCard`, off until the merchant sets one up): one stamp when a member's order is paid
and the amount actually paid reaches the card's minimum (a free order earns none); each order stamps once; a full card
turns into a reward voucher and starts again; the shop shows the card. There is no screen
yet to set the card up (it is configuration) and no stamp reversal on a refund after payment. There is no screen
yet for a manager to issue coupons (`MemberStore.grantCoupon` is the hook).

## Outside services (all optional; set in the environment)
The shop works with none of these (email code, pay at the counter). Each one a deployment sets up appears in
`GET /api/shop/info` (`auth`, `payments`) and the page switches on only those. Set `PUBLIC_URL` to the address
customers use (no trailing slash, e.g. `https://order.example.com`; locally `http://localhost:5173`): providers send
people back there.

| Feature | Settings | What to configure at the provider |
|---|---|---|
| Google sign-in | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | OAuth client (web). Redirect URI: `$PUBLIC_URL/api/shop/auth/oauth/google/callback` |
| Microsoft sign-in | `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` | Entra app, "personal + work accounts". Redirect URI: `$PUBLIC_URL/api/shop/auth/oauth/microsoft/callback` |
| Email (sign-in codes, order-ready notices) | `RESEND_API_KEY`, `MAIL_FROM` (e.g. `Bailey & Patch <orders@yourshop.com>`) | A Resend account with the sending domain verified. Uses Resend's web API over HTTPS, so it works where SMTP ports are blocked. A member gets one "your order is ready" email per order, unless they turned order updates off in Account > Preferences |
| Phone sign-in (reverse SMS) | `SMS_RECEIVE_NUMBER` (the number customers text, shown to them), `SMS_WEBHOOK_SECRET` | Point the number's "incoming message" webhook (Twilio style: form fields `From`, `Body`) at `$PUBLIC_URL/api/shop/auth/phone/inbound?secret=<SMS_WEBHOOK_SECRET>` |
| Card and PayNow | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Stripe account in Singapore with PayNow enabled. Webhook to `$PUBLIC_URL/api/shop/stripe/webhook` for `checkout.session.completed` and `checkout.session.async_payment_succeeded` |

How they behave. **Google / Microsoft**: authorization code with PKCE; the browser gets a one-time ticket (2 minutes,
used once) rather than a token in the address. A returning identity is always the same member. A new Google identity
joins an existing account with the same email only because Google states the email is verified; Microsoft does not,
so it never joins by email (it makes its own account). **Phone**: the customer texts a 6-digit code *from* their
number; the sender number plus the code prove it. Codes last 5 minutes, work once, and a new request retires the old
one. A phone-only member has no email. Outside production with no SMS number set, a simulated number and a "pretend
the text arrived" button let you try the whole flow. **Card / PayNow**: `POST /api/shop/orders/:id/pay` creates a
Stripe-hosted payment page for exactly what is still owed (SGD); the webhook is checked against Stripe's signature
(5-minute window) and only records a payment whose amount matches what is due on a non-cancelled order, once per Stripe
session. A payment recorded this way earns points and stamps like one taken at the till. A payment that does not fit
(wrong amount, order already cancelled, already paid) is not recorded and is **refunded in full automatically** (the refund uses a fixed
key per payment, so Stripe's repeat messages refund once). If the refund call fails, an error line saying `REFUND FAILED` is logged: refund it by hand in Stripe.
**Cancelling**: `POST /api/shop/orders/:id/cancel` works for an online order nothing has been paid on and the kitchen
has not started; spent points and a used coupon come back. **History**: `GET /api/shop/me/orders`.

## Splitting a bill
`packages/core/src/tab.ts` holds the Tab & Split & Pay money rules, tested against the spec's worked examples: the
whole tab is priced once (service charge on the whole bill, so shares always add up: S$19.18, or S$26.58 once the
S$7.40 bag is added), service is shared pro-rata on each person's items, a BCRS deposit stays with its item, equal
splits floor to the cent with the Host taking the leftover cents (S$19.18 / 3 = S$6.40, S$6.39, S$6.39), and tab
rewards are earned by each payer on what they paid, only once the whole tab is paid (with "let the host keep the
reward"). On the till, an open tab (restaurant mode) has a **Split** button: split between 2 to 10 people (next share
paid in cash or credit, the people count drops as shares are paid) or take any amount. Not built: the customer-facing
tab (joining a table by QR, everyone seeing the bill, paying their own share from their phone), "pay mine" by name
chip, by-round, waiter release/merge and the page-waiter bell. Each of those needs online payment or accounts per diner.

## Not built yet
YeahPay integration (the "PayNow / Card" button uses a **mock** gateway), combine bills and the customer-facing tab,
delivery workflow, USB and Bluetooth printers (hub app only), auth/roles, admin & menu management, reports, LAN hub, wallet/credit screens in the POS,
a way for managers to issue coupons, a screen for editing item options, Tab and Split bill in the customer page, translating menu item names and descriptions (the shop's own wording is shown as entered), table QR code generation, per-outlet routing for multiple outlets (the data model and price resolution already support outlets; only assigning a pricebook to an outlet is API-only for now), Redis-backed rate limits and stream tickets (both are in memory, one server only), night-club allocation module (see `docs/open-questions.md`).

## Deploying on Render

`render.yaml` is a Render Blueprint: one web service (the API and the built web app together) and one Postgres database, both in Singapore.

1. Push the repo to GitHub, then in Render choose New → Blueprint and pick the repo.
2. Fill in the settings marked `sync: false`. Set `PUBLIC_URL` to the final address, e.g. `https://order.yourshop.com`. Leave the provider keys empty to keep that feature off.
3. After the first deploy, open the service's Shell and create staff: `cd apps/server && npx tsx src/cli.ts create-staff <code> <name> <cashier|manager|owner> <pin>` (the `npm run cli` shortcut points at the local dev database, so don't use it there). It needs `DATABASE_URL`, which Render already sets.
4. Register the redirect and webhook addresses with each provider, all under `PUBLIC_URL`: `/api/shop/auth/oauth/google/callback`, `/api/shop/auth/oauth/microsoft/callback`, `/api/shop/stripe/webhook`, and `/api/shop/auth/phone/inbound?secret=...`.
5. Turn on point-in-time recovery for the database (paid plans) before taking real orders.

The server serves `apps/web/dist` when it exists, so there is nothing else to host.

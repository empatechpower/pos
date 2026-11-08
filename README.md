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
and whether service charge applies. A **pricebook** is a price list. The price of an item for an outlet +
channel is the first hit of: pricebook assigned to *outlet and channel* → to the *channel* → to the *outlet* →
the merchant's *default*. An item missing from a pricebook uses the next one down, unless that pricebook is set to
"don't sell them". Resolution is one pure function in `packages/core/src/catalog.ts`, run on the device from a
cached copy of the whole catalog, so every channel prices correctly offline. Orders freeze the channel and the
price when placed; later price changes never touch them.
Managers/owners change prices, channels, assignments and items on the **Prices** screen (or `/api/catalog/*`);
every change is validated as a whole, versioned, and audited with the old and new value.
Sample data (`apps/server/src/catalogSeed.ts`): the Grab uplift (+15%, rounded up to 5c) is invented for the demo.

## Printing (needs `DATABASE_URL`)
`packages/core/src/print/`: a printer-agnostic document model, a receipt, a kitchen ticket and an item label,
and three encoders: **ESC/POS** (receipt and kitchen printers, 32/42/48 columns, QR, Code 128, cash drawer, cut),
**ZPL II** and **EPL2** (Zebra label printers, laid out in mm so one layout fits 203 or 300 dpi). Text is folded to
ASCII (see `toAscii`): Chinese, Tamil and other scripts print as `?` until a CJK mode or image path is added.
`apps/server/src/print.ts`: printers (Manager screen/API: `PUT /api/printers/:id`) and a durable queue. When an
order's events arrive the server queues what is now printable: the kitchen ticket (fast serve: once paid;
restaurant: immediately), the receipt once fully paid (cash opens the drawer), a label per unit. Later additions
to an open tab print as an **ADD-ON** with only the new items. A printer can take only some menu categories
(a bar printer for Drinks). Jobs are stored as final printer bytes, leased to a delivery agent, retried with
growing delays (5 s, 15 s, 45 s, 2 min) up to 5 attempts, then marked failed for a manager to retry; a job whose
agent died mid-print is handed out again. `apps/server/src/printAgent.ts` (run `POS_URL=… DEVICE_TOKEN=… npx tsx
apps/server/src/agent.ts`) delivers jobs to printers' raw TCP port 9100 and is the reference for the hub app.
A raw TCP write proves the bytes reached the printer, not that paper came out (no out-of-paper detection yet).
Screens: **Printers** (managers/owners) adds and edits printers, sends a test page, shows recent jobs and retries
failed ones, with a red count on the nav link when something failed for good. **Orders** (any signed-in staff)
lists recent orders with Receipt / Kitchen ticket reprint buttons.

## Not built yet
YeahPay integration (the "PayNow / Card" button uses a **mock** gateway), split/combine bills,
delivery workflow, USB and Bluetooth printers (hub app only), auth/roles, admin & menu management, reports, LAN hub, wallet/credit screens in the POS,
customer ordering app (needs a public, non-enrolled path), per-outlet routing for multiple outlets (the data model and price resolution already support outlets; only assigning a pricebook to an outlet is API-only for now), Redis-backed rate limits and stream tickets (both are in memory, one server only), night-club allocation module (see `docs/open-questions.md`).

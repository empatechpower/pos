# Brand, franchise and outlet

The first foundation for running more than one outlet under one brand.

## Shape

- **Brand** = the merchant (`merchant_id`). One server runs one brand today.
- **Franchise** (optional) groups outlets. **Outlet** is one trading place. The original outlet (`config.outletName`) is created automatically at start, so existing data and devices keep working.
- Events, devices, printers and print jobs already carried an `outlet_id`; it now means something.

## Who sees what

A login has an optional **franchise** or **outlet** (never both):

| Login scope | Sees |
|---|---|
| neither (brand-wide) | every outlet: orders, reports, devices, printers, print jobs |
| a franchise | only that franchise's outlets |
| an outlet | only that outlet |

This is enforced on the server for: reports (`/api/reports/orders`, `/sales`, `/outlets`, with `?outlet=`), devices, printers, print jobs, reprint and retry, and staff creation (you can only hand out access inside your own scope). A scope that points at something that no longer exists sees nothing.

- The **menu, prices and categories belong to the brand**: scoped logins can read them but not change them (`brand_only`).
- Only a brand-wide owner adds franchises or outlets, moves an outlet between franchises, or switches one off. A manager of an outlet (or franchise) can update that outlet's name, address, phone and opening hours.
- A device syncs only its own outlet's events, and an order prints only at the outlet that took it.

## Endpoints

- `GET /api/outlets` the franchises and outlets this login may see, and its scope.
- `PUT /api/franchises/:id`, `PUT /api/outlets/:id`.
- `POST /api/staff` takes `franchiseId` or `outletId`.
- `POST /api/devices/enrollment` takes `outletId` (default: the login's own outlet, else the original one).
- `GET /api/reports/outlets` one row per visible outlet plus a total: the brand owner's roll-up.

Manager → **Outlets** shows the same in the app.

## Opening hours, phone and address

Customers see them under Help & support, from the outlet's own setup. `OUTLET_HOURS`, `OUTLET_PHONE` and `OUTLET_ADDRESS` are only a fallback until the outlet is filled in, and can be deleted.

## Not built yet

- **Several brands on one server** (a request still resolves to the one configured merchant).
- **Per-outlet** tax and service rate, table list, queue numbers and Telegram reports, and which parts of the menu or prices an outlet overrides.
- **Members and credit** are brand-level; whether they work across franchises is a rule for the handover.
- Fine-grained permissions (to be discussed).

## Adding a store (outlet) and putting its hub in

1. **Manager → Outlets → Add outlet.** Give it a short code (for example `AMK-01`), a name, address, phone and hours. Pick a franchise if it belongs to one.
2. **A login for the store** (optional): create staff with that outlet (`POST /api/staff` with `outletId`) so its manager sees only that store.
3. **Link the tablet:** Manager → Devices, choose the outlet, press **Add a device**, and type the code into the Rezein app on that tablet. From a computer: `npx tsx apps/server/src/cli.ts enrollment-code AMK-01`.
4. **Printers:** Printers → Add a printer, and choose the outlet. Orders print only at printers of the outlet that took them.
5. **Customer QR codes** carry the outlet: `https://YOUR-SHOP-ADDRESS/#/shop?table=5&outlet=AMK-01`. A link without `outlet` is the original outlet. The page then shows that store's name, address and hours, prices it with that outlet's pricebook, records the order at that store, and counts only that store's orders in the queue.

Still shared by every store: the table list (`SHOP_TABLES`), the menu, members and credit.

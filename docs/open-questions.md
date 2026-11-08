# Open questions (blocking or shaping the build)

See the full lists in the project discussion. The ones that gate code:

## Product
1. One product for many businesses, or one client first? Which mode first?
2. Is the customer ordering app (Bailey prototype) still in scope, or staff POS only?
3. Must kitchen/queue screens work with no internet? (If yes, a LAN hub is required.)

## Payments (YeahPay)
- Does the client have a YeahPay merchant ID, appId and apiKey? Static outbound IP for the whitelist?
- Hosted cashier vs QR-only? Card terminals (Cloud MISPOS / Serial POS)? Offline behaviour of terminals?
- Callback signature rules and failure/expiry notifications (docs are inconsistent).

## Night club allocation module (`modules.allocation`, OFF, not built)
- Who keys in allocations, when, and how is money paid out and held in between?
- "Secret" must mean hidden from ordinary staff only. Build as an auditable ledger visible to the owner.
- Legal check first: passing shares of customer payments to third parties may need a licence in
  Singapore, and may breach the payment gateway merchant agreement. Commission is taxable income.


## Assumptions made while building channels and pricebooks (confirm with the client)
- **Missing price in a pricebook:** falls back to the default pricebook. Each pricebook can instead be set to hide the item. (Question A1)
- **Service charge:** decided per channel (on for Dine in only in the sample data), not per outlet. (Question A2)
- **Grab uplift:** the sample Grab pricebook is the default price + 15% rounded up to 5c. Invented, not from the client.
- **Cashier top-up cap:** S$200 per top-up. Managers and owners are uncapped.
- **Pricebook precedence:** outlet+channel, then channel, then outlet, then default. Confirm this matches how they think about it, especially "channel beats outlet".
- **Catalog is public** (`GET /api/catalog`): it holds menu and prices only, so the customer ordering app can read it.

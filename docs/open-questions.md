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


## Assumptions made while building customer ordering (confirm with the client)
- **How do customers pay online?** The client said prepaid credit only. Spending credit from a phone needs the
  customer to prove who they are. A phone number alone is not proof (anyone could spend someone else's credit), so
  v1 has no online payment: the customer orders, and pays at the counter in cash or credit. Options for later:
  SMS one-time codes (needs an SMS provider and cost), or a member PIN set up in the shop. Which does the client want?
- **Staff must accept every online order** before the kitchen sees it (stops spam and mistaken orders). Is that too
  slow for busy periods? An alternative is auto-accept for customers who have ordered before.
- **Customer details:** name and mobile are optional. Is a phone number required (to call about a problem)? What does
  their privacy policy / PDPA notice need to say?
- **Online order numbers** are `W001`, `W002`... restarting daily, so they never clash with till letters.
- **Languages:** the prototype has 8; the customer page is English only for now.
- **Coupons, points and the rewards screens** from the prototype are not in the customer page yet.
- **Tables:** the QR code carries the table name (`?table=Table%205`). Who prints and places the codes?


## From rebuilding the customer page to match the prototype (confirm with the client)
- **Login options.** The prototype's first screen offers Google, Microsoft, ID/email, phone number (one-time code) and
  guest. Is that the intended list for the real product? Each needs setup (Google/Microsoft developer accounts, an SMS
  provider for phone codes). The customer page is guest-only today. This also decides how customers could pay with
  prepaid credit online.
- **Rewards, points, coupons and stamp cards** (the prototype's Rewards and Account screens) need customer accounts first.
- **Languages:** the prototype offers 8 (English, Malay, Indonesian, Chinese, Japanese, French, German, Tamil). Which are required?
- **Gelato flavours and toppings:** please send the flavour list for Single/Double Scoop Gelato.
- **"Take Away Only" items:** should the customer page hide them for Dine in? (Needs a per-item channel rule.)
- **Option prices per channel:** option prices (e.g. Cold +S$0.80) are the same in every channel today; only the item's base price follows the pricebook. Is that right for Grab and events?
- **Item photos:** the prototype's are small (up to 36 KB). Do they have better originals?
- **Multiple outlets:** the prototype lists several outlets (all marked demo). Real outlet names and addresses?

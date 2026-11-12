# Event runbook: credit purchases (14 November 2026)

Written against the Rezein developer handout (section 0 and the release gates). The rules in the handout are final; this page says where each one lives in the code and what the operator does when something goes wrong.

## How a credit purchase works

1. The customer signs in (phone, by texting the code shown to the Rezein tablet) and pays with member credit. The shop page makes one **idempotency key** for the attempt and sends it with the order.
2. The server looks at the key first. A key it has seen before with the same content returns the first result (`replayed: true`); the same key with different content is refused (`idempotency_key_reused`); an attempt still running returns `purchase_in_progress`.
3. Prices and totals are worked out on the server from the catalogue. Nothing the phone sends is trusted as a price. If the total the customer saw is out of date, the order is stopped with `price_changed` before any money moves.
4. The wallet row is locked and the debit is written to the append-only ledger in one step that cannot take the balance below zero. Then the order is recorded as paid and accepted.
5. If the order cannot be recorded, the debit is reversed at once. If the server itself stops between the two steps, a sweep reverses any debit that has no order behind it after two minutes (it runs when the server starts and every five minutes). The reversal has one fixed key per order, so it can only happen once.
6. Tickets print only after the order is recorded. A print failure never touches the money: staff press Reprint.
7. After a timeout the phone keeps its key. Tapping Pay again returns the first result; it cannot debit twice. `GET /api/shop/purchases/<key>` tells a signed-in member what became of an attempt.

## Release gates and where they are tested

All are in `apps/server/test/eventGates.test.ts` unless noted.

| Gate | Test |
|---|---|
| Successful purchase | "a purchase succeeds, debits once, and creates the paid order in the same step" |
| Insufficient funds rejected | "insufficient funds are rejected and nothing changes" |
| Double tap / retry does not double charge | "a double tap or retry with the same key never charges twice" |
| Same key, changed content, fails | "the same key with different content is refused" |
| Concurrent spending cannot overspend | "two purchases at once cannot overspend one balance" |
| Timeout after commit recovers | the double-tap test (retry after the first succeeded) and "the phone can ask what became of its attempt" |
| Client-side price tampering rejected | "a price sent by the phone is not trusted" |
| Server stopped between debit and order | "a debit left with no order … is reversed" |
| Guests cannot spend; a phone number alone never spends | "a credit purchase without an idempotency key, or from a guest, is refused" |
| Print failure means reprint only | `hub.test.ts` (failed and unconfirmed jobs are retried or reprinted, never re-debited) |
| Duplicate / excess refund rejected | "a refund is a linked reversal …" and "two refunds at once cannot both pass the limit" |
| Money reconciles | "the money reconciles" (`GET /api/wallet/reconciliation`) |
| Cross-tenant access impossible | Not applicable as built: each deployment serves one merchant, and every query is scoped by `merchant_id`. A second tenant on the same database has not been built or tested. |

## Opening balances

Import once from Manager, Members, upload a list. Each opening credit is posted with the key `open:<member id>`, so importing the same list again changes nothing, and its ledger note names the file it came from ("Opening credit (import: <file name>)"). Purchased and promotional credit are not separated yet; if their policies differ, tell the developer before the import.

Reconcile before and after the event: `GET /api/wallet/reconciliation` (owner or manager, signed in on an enrolled device) returns opening, other credits, debits, reversals, adjustments and closing, and `balanced: true` only when they add up and every wallet equals its own entries.

## Credit spending is online-only

Credit cannot be spent offline. The till does not spend credit without a connection and nothing here promises otherwise.

## If something goes wrong (operator procedure)

Named operator for the event: ____________________  Phone: ____________________

1. **Stop unverified spending.** If the shop cannot confirm balances (server down, database unreachable), stop taking credit. Do not accept "the member says they have credit".
2. **Keep a numbered incident log** on paper or a shared sheet: number, time, table or member, what happened, what was done, who decided. Every manual transaction goes in it.
3. **A customer says they were charged and got no order.** Do not top up by hand. Ask for the time and the member's phone number. Find the member in Manager, Members. Look for an order from that time under Manager, Transactions. If there is no order, the sweep reverses the debit within about five minutes, or a manager can refund against the order id shown in the ledger. A refund must name the order and cannot exceed what that order took.
4. **A ticket did not print.** Use Reprint on the order card. Printing never changes a balance.
5. **After the event:** run the reconciliation. If `balanced` is false, stop, do not correct anything by hand, and send the output to the developer.

## Restore

Render keeps backups of the database depending on the plan. Before the event, open the database in the Render dashboard, find its Recovery or Backups section, confirm what is available, and do one test restore into a new database. A restore is not demonstrated until that has been done and written down here with the date.

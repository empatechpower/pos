# Agents: limited access for an AI helper or script

An agent signs in with **one key** (no device, no PIN) and has a deliberately small set of powers.

## Connect Muse (the normal way)
Manager → **Agents** (owner only) → **Make a connect code**. Give the code to Muse. Muse sends it to `POST /api/agents/connect` with `{ "code": "AB3K-9XQ2", "name": "Muse" }` and gets its key back.
The code works once and expires in 15 minutes. **Stop** on the agent turns its key off at once.

## Or make a key by hand
Manager → **Agents** → name it → **Make an agent**. The key (`agt_…`) is shown once. Lose it, stop that agent and make another.

## What an agent can and cannot do
| Can | Cannot |
|---|---|
| Change prices, items, categories, options, sold-out and on/off | Add, take, refund or set member credit |
| Read members, credit, the credit report and the audit log | Freeze or unfreeze credit |
| Reprint receipts and kitchen tickets | Manage printers, devices or staff, or make other agents |

Everything an agent does is recorded in the audit log under its name (`Agent: <name>`).

## Calling the server
The full list of calls is in [agent-openapi.yaml](agent-openapi.yaml), also served at `/api/agent/openapi.yaml`.
Send the key in the `x-agent-key` header, and on every call `x-agent-actor` with the person it is acting for, for example `Sam via Telegram`.
Every change is then written to the audit log as `agent.call` with that name, the path and the result. Examples (replace the address and key):

    curl -H "x-agent-key: agt_..." https://demo.rezein.com/api/catalog
    curl -X POST -H "x-agent-key: agt_..." -H "content-type: application/json" \
      -d '{"id":"p114","name":"Pet Cai Fan (~180g)","category":"...","soldOut":true}' \
      https://demo.rezein.com/api/catalog/products
    curl -H "x-agent-key: agt_..." https://demo.rezein.com/api/reports/credit
    curl -X POST -H "x-agent-key: agt_..." -H "content-type: application/json" \
      -d '{"orderId":"...","docType":"kitchen"}' https://demo.rezein.com/api/print/reprint

For analysis: `GET /api/reports/sales?from=2026-11-14&to=2026-11-14` (totals, by day, by hour, products ranked) and `GET /api/reports/orders?from=…&to=…` (every order with items, totals and payments).

Useful routes: `GET /api/catalog` (menu and prices), `POST /api/catalog/products` (add or change an item; fields not sent are kept),
`POST /api/catalog/categories/rename`, `PUT /api/catalog/pricebooks/:id/prices/:productId`, `GET /api/members`,
`GET /api/members/:id/credit-history`, `GET /api/reports/credit`, `GET /api/print/order-status?ids=…`, `GET /api/audit`.

## Telegram
Each person in `TELEGRAM_MANAGER_IDS` now gets a login of their own, named after their Telegram profile (for example `Telegram: Sam @sam`),
so the audit log says who did what. Before, everyone shared one "Telegram manager" login.

### Working the bot (an AI assistant that uses Telegram)
An assistant such as Meta's Muse can message the Rezein bot as the manager, so it needs no API key. The bot answers only Telegram accounts
that are linked or listed in `TELEGRAM_MANAGER_IDS` / `TELEGRAM_ADMIN_IDS`. Commands an assistant can use:

| Say | What happens |
|---|---|
| `/price kaya toast 2.50` | change a price |
| `/off teh`, `/on teh` | switch an item off or on |
| `/rename Latte > Flat White` | rename an item (price, options and photo stay) |
| `/rename Drinks > Beverages` | rename a category |
| send a photo, caption `kaya toast` | set that item's picture (up to 300 KB) |
| `/sales today` (or `yesterday`, `week`, `month`, `2026-11-14`) | totals, channels, top items |
| `/orders week` | every order as a CSV file, for analysis |
| `/items kaya` | find an item and its prices |

Credit, top-ups, refunds and staff cannot be done through the bot.

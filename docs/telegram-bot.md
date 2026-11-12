# Telegram bot for prices

Staff with permission to manage the catalogue (managers and the owner) can run pricebooks by chatting with a Telegram bot.

## What it does

Send it these commands in a private chat (it asks follow-up questions with buttons):

- `/newpricebook Grab`: copies everything from Dine in (prices and which items are off) into a new pricebook and a new channel with the same name. It asks what kind of channel it is (dine in, takeaway or delivery).
- `/price latte 5.50`: changes one item's price. It asks which item if several match, and which pricebook (or all of them).
- `/off cheesecake` / `/on cheesecake`: **Off** hides the item online and greys it out on the till. The price is kept. $0 is a real, sellable price.
- `/edit`: sends a one-time link to a page with every item in a table, for mass changes. Nothing is saved until you press **Save changes**, and it is all-or-nothing.

Every change is written to the audit log as made via Telegram.

## One-time setup (the owner does this)

1. In Telegram, open **@BotFather**, send `/newbot`, follow the prompts. Copy the token it gives you. Do not paste it in chat or commit it.
2. In Render, open the web service, then Environment, and add:
   - `TELEGRAM_BOT_TOKEN` = the token
   - `TELEGRAM_WEBHOOK_SECRET` = a long random string (for example 40 random letters and digits)
3. Save. Render redeploys. On start the server registers its webhook with Telegram (`PUBLIC_URL` must be the public address, e.g. `https://demo.rezein.com`). The log shows `[telegram] webhook set to ...`.
4. Sign in as manager or owner, open **Manager, Telegram**, press **Make a code**, then send `/link CODE` to the bot. The code works once and lasts 10 minutes.

Disconnect someone from the same Telegram tab. Only linked people with the catalogue permission can use the bot; anyone else is ignored. Group chats are ignored.

## Notes

- The editor link signs the person in on that browser without a PIN. It works once and lasts 10 minutes, so do not forward it.
- The bot has not yet been tried against real Telegram (tests use a fake). Try it first in a private chat before the client trial.
- The till (POS) greying-out of Off items is not built yet; online ordering already hides them.

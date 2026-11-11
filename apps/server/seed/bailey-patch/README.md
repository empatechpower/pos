# Bailey & Patch starting menu

Imported from the client's prototype (`demo.01c.io/muse/tsrmu`): 132 items in 19 categories with a photo on every
item, plus the logo and the café photo used as the shop's top image. A brand-new database starts with this
(`SEED=sample npm run dev:server:pg` starts with a tiny demo menu instead).

- `products.json` – id, name, name in Chinese (`altName`), category, price in cents, description, sold-out and
  points-exempt flags (the prototype exempts the *Beer / Whisky* category), photo file, and options.
- `images/` – the item photos (JPEG). `logo.jpg`, `hero.jpg` – shop logo and top photo.

## Options (from the prototype's variant notes)
Hot/Cold (Coffee, Honey Kamquat), Half/Full pint (Asahi), 1 bottle/Twin bottles (Whisky), 1 pax/4-6 pax (Crab soup),
protein choices with their own prices (Pet Cubes, Meat Lover), a flavour list (Pet IceCream), and the Karaage rice's
egg style and priced extras. The first choice of each is the base price; others add the difference.

## Not imported (needs the client)
- **Single / Double Scoop Gelato**: the prototype only says "same flavour list as Menu 1, toppings +$1.00 each, max 4";
  the flavour list itself is not in the prototype.
- **Take Away Only** items (two Pet Cubes packs) are sold in every channel for now; there is no per-item channel rule yet.
- **Build Your Own Bowl**: a demo builder in the prototype, not part of the 132 items.
- **Pet IceCream - Blueberry Burst**: its note lists other flavours; "Blueberry Burst" is offered as the default choice
  because it is the item's own name. Confirm.

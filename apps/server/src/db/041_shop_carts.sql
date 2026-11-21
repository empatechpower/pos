-- Server-side carts (backend handout, sections 8 and 9): one per customer per outlet, so switching outlet never destroys the other cart.
-- owner is "m:<member id>" when signed in, else "a:<key>" from the phone's own cart key.
CREATE TABLE IF NOT EXISTS shop_carts (
  merchant_id text NOT NULL,
  owner       text NOT NULL,
  outlet_id   text NOT NULL,
  lines       jsonb NOT NULL DEFAULT '[]',
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, owner, outlet_id)
);

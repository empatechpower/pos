-- Stock (14 Nov handout, schema: stock_basis, recipe, inventory_item, stock_movement). A product's stock basis is data on the product;
-- stock items are brand-wide; movements are append-only and carry the outlet, so every outlet has its own on-hand.
ALTER TABLE products ADD COLUMN IF NOT EXISTS stock jsonb;

CREATE TABLE IF NOT EXISTS inventory_items (
  merchant_id text NOT NULL,
  id          text NOT NULL,
  name        text NOT NULL,
  unit        text NOT NULL DEFAULT 'pcs',      -- what a whole number of this item means: pcs, g, ml...
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, id)
);

-- Never updated and never deleted: the on-hand figure is the sum of a stock item's movements at an outlet. A sale writes a movement per item;
-- a cancelled order writes the opposite; a stocktake writes the difference.
CREATE TABLE IF NOT EXISTS stock_movements (
  id          bigserial PRIMARY KEY,
  merchant_id text NOT NULL,
  item_id     text NOT NULL,
  outlet_id   text NOT NULL,
  delta       integer NOT NULL,
  reason      text NOT NULL CHECK (reason IN ('receive','count','waste','adjust','sale')),
  order_id    text,
  line_id     text,
  note        text,
  staff_id    text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stock_movements_item ON stock_movements (merchant_id, outlet_id, item_id);
CREATE INDEX IF NOT EXISTS stock_movements_order ON stock_movements (merchant_id, order_id) WHERE order_id IS NOT NULL;

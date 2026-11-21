-- Menus are published per outlet (backend handout, section 8). The brand's catalogue is the starting point; an outlet overrides only what differs
-- there: items off or sold out, its own build rules, sold-out options. An outlet also has a prep-time estimate in minutes.
ALTER TABLE outlets ADD COLUMN IF NOT EXISTS prep_minutes int;
ALTER TABLE outlets ADD COLUMN IF NOT EXISTS menu_version int NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS outlet_menu_overrides (
  merchant_id text NOT NULL,
  outlet_id   text NOT NULL,
  product_id  text NOT NULL,
  data        jsonb NOT NULL,
  PRIMARY KEY (merchant_id, outlet_id, product_id)
);

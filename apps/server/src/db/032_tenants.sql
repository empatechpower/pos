-- Brand -> franchise -> outlet. The merchant is the brand. A franchise groups outlets; an outlet is one place that trades.
-- Staff may be scoped: no franchise and no outlet = the whole brand; a franchise = its outlets; an outlet = that outlet only.
CREATE TABLE IF NOT EXISTS franchises (
  merchant_id text NOT NULL,
  id          text NOT NULL,
  name        text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, id)
);

CREATE TABLE IF NOT EXISTS outlets (
  merchant_id  text NOT NULL,
  id           text NOT NULL,              -- the same value as events.outlet_id, devices.outlet_id, printers.outlet_id
  name         text NOT NULL,
  franchise_id text,
  address      text,
  phone        text,
  hours        text,                       -- shown to customers on Help; replaces the OUTLET_HOURS setting
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, id),
  FOREIGN KEY (merchant_id, franchise_id) REFERENCES franchises (merchant_id, id)
);

ALTER TABLE staff ADD COLUMN IF NOT EXISTS franchise_id text;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS outlet_id text;

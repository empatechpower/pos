-- Catalog: products, pricebooks (price lists), channels and where each pricebook applies.
-- catalog_meta.version goes up on every change; devices compare it to know their copy is stale.
CREATE TABLE IF NOT EXISTS catalog_meta (
  merchant_id          text PRIMARY KEY,
  version              bigint NOT NULL DEFAULT 1,
  default_pricebook_id text NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  merchant_id   text NOT NULL,
  id            text NOT NULL,
  name          text NOT NULL,
  category      text NOT NULL,
  sold_out      boolean NOT NULL DEFAULT false,
  points_exempt boolean NOT NULL DEFAULT false,
  sort          serial,
  PRIMARY KEY (merchant_id, id)
);

CREATE TABLE IF NOT EXISTS pricebooks (
  merchant_id text NOT NULL,
  id          text NOT NULL,
  name        text NOT NULL,
  missing     text NOT NULL DEFAULT 'fallback' CHECK (missing IN ('fallback','hide')),
  PRIMARY KEY (merchant_id, id)
);

CREATE TABLE IF NOT EXISTS pricebook_prices (
  merchant_id text NOT NULL,
  pricebook_id text NOT NULL,
  product_id  text NOT NULL,
  price_cents bigint NOT NULL CHECK (price_cents >= 0),
  PRIMARY KEY (merchant_id, pricebook_id, product_id)
);

CREATE TABLE IF NOT EXISTS channels (
  merchant_id    text NOT NULL,
  id             text NOT NULL,
  name           text NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('dine_in','takeaway','delivery','other')),
  service_charge boolean NOT NULL DEFAULT false,
  active         boolean NOT NULL DEFAULT true,
  sort           serial,
  PRIMARY KEY (merchant_id, id)
);

CREATE TABLE IF NOT EXISTS pricebook_assignments (
  merchant_id  text NOT NULL,
  pricebook_id text NOT NULL,
  outlet_id    text,
  channel_id   text,
  CHECK (outlet_id IS NOT NULL OR channel_id IS NOT NULL)
);
-- One pricebook per (outlet, channel) combination; NULL means "any".
CREATE UNIQUE INDEX IF NOT EXISTS pricebook_assignments_key
  ON pricebook_assignments (merchant_id, COALESCE(outlet_id, ''), COALESCE(channel_id, ''));

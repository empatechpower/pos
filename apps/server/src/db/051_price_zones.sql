-- Price Zones (Q&A A-3): a named group of outlets that, per channel, points at one pricebook. HQ assigns; prices stay in pricebooks.
CREATE TABLE IF NOT EXISTS price_zones (
  merchant_id text NOT NULL,
  id          text NOT NULL,
  name        text NOT NULL,
  PRIMARY KEY (merchant_id, id)
);
-- An outlet belongs to one zone.
CREATE TABLE IF NOT EXISTS price_zone_outlets (
  merchant_id text NOT NULL,
  outlet_id   text NOT NULL,
  zone_id     text NOT NULL,
  PRIMARY KEY (merchant_id, outlet_id)
);
CREATE TABLE IF NOT EXISTS price_zone_books (
  merchant_id  text NOT NULL,
  zone_id      text NOT NULL,
  channel_id   text,
  pricebook_id text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS price_zone_books_key ON price_zone_books (merchant_id, zone_id, COALESCE(channel_id, ''));

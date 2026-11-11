-- Rich menu items (description, other-language name, options, photo) and a fuller shop look
-- (hero photo, tagline, promotion). Photos live in their own table so reading the catalog never loads them.
ALTER TABLE products ADD COLUMN IF NOT EXISTS description   text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS alt_name      text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS options       jsonb;
ALTER TABLE products ADD COLUMN IF NOT EXISTS image_version int NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS product_images (
  merchant_id text NOT NULL,
  product_id  text NOT NULL,
  bytes       bytea NOT NULL,
  type        text NOT NULL,
  version     int NOT NULL DEFAULT 1,
  PRIMARY KEY (merchant_id, product_id)
);

ALTER TABLE merchant_brand ADD COLUMN IF NOT EXISTS hero         bytea;
ALTER TABLE merchant_brand ADD COLUMN IF NOT EXISTS hero_type    text;
ALTER TABLE merchant_brand ADD COLUMN IF NOT EXISTS hero_version int NOT NULL DEFAULT 0;
ALTER TABLE merchant_brand ADD COLUMN IF NOT EXISTS tagline      text;
ALTER TABLE merchant_brand ADD COLUMN IF NOT EXISTS promo_title  text;
ALTER TABLE merchant_brand ADD COLUMN IF NOT EXISTS promo_body   text;

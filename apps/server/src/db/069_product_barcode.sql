-- A barcode (or SKU) on an item, so the till can add it by scanning or typing the code. One code belongs to one item.
ALTER TABLE products ADD COLUMN IF NOT EXISTS barcode text;
CREATE UNIQUE INDEX IF NOT EXISTS products_barcode ON products (merchant_id, barcode) WHERE barcode IS NOT NULL;

-- Tax on a product: its price already includes tax (overrides the merchant default), and which tax group it is in when not the default GST.
ALTER TABLE products ADD COLUMN IF NOT EXISTS tax_inclusive boolean;
ALTER TABLE products ADD COLUMN IF NOT EXISTS tax_group     text;

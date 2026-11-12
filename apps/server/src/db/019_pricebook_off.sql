-- An item switched off in one pricebook: hidden from online ordering for channels that use it, greyed out on the POS.
-- The item keeps its price there, so switching it back on needs no retyping.
CREATE TABLE IF NOT EXISTS pricebook_off (
  merchant_id  text NOT NULL,
  pricebook_id text NOT NULL,
  product_id   text NOT NULL,
  PRIMARY KEY (merchant_id, pricebook_id, product_id)
);

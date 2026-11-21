-- A category's name in other languages, as the merchant wrote it: {"zh": "吐司", "ms": "Roti Bakar"}. Blank or missing means "show the category as entered".
CREATE TABLE IF NOT EXISTS category_names (
  merchant_id text NOT NULL,
  category    text NOT NULL,
  names       jsonb NOT NULL,
  PRIMARY KEY (merchant_id, category)
);

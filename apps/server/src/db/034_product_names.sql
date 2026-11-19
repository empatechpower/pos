-- The name of an item in other languages, as the merchant wrote it: {"zh": "咖椰面包", "ms": "Roti Kaya"}. Blank or missing means "show the name as entered".
ALTER TABLE products ADD COLUMN IF NOT EXISTS names jsonb;

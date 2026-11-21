-- Build-your-own products: the rule sets (groups, minimums and maximums, allowances, option prices), per product or per variant. Data, never code.
ALTER TABLE products ADD COLUMN IF NOT EXISTS builder jsonb;

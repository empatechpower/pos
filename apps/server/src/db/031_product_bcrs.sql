-- The container deposit (BCRS) is a setting on the item, not something guessed from its name at the till.
-- Items that already carry "BCRS" in their name keep their deposit: the setting is switched on for them once, here.
ALTER TABLE products ADD COLUMN IF NOT EXISTS bcrs boolean NOT NULL DEFAULT false;
UPDATE products SET bcrs = true WHERE name ILIKE '%bcrs%';

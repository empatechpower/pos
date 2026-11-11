-- Spec A-1: an item with no price in a channel's pricebook can never be ordered there; there is no fallback
-- to another pricebook. "fallback" becomes "show" (listed but blocked).
ALTER TABLE pricebooks DROP CONSTRAINT IF EXISTS pricebooks_missing_check;
UPDATE pricebooks SET missing='show' WHERE missing='fallback';
ALTER TABLE pricebooks ALTER COLUMN missing SET DEFAULT 'show';
ALTER TABLE pricebooks ADD CONSTRAINT pricebooks_missing_check CHECK (missing IN ('show','hide'));

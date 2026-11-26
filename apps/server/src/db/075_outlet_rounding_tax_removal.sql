-- Two outlet choices the owner settled on 25 Nov 2026: rounding by tender (off unless chosen; cash first), with the step taken from the
-- outlet's country; and whether staff may take tax off an order (off unless switched on).
ALTER TABLE outlets ADD COLUMN IF NOT EXISTS tender_rounding jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE outlets ADD COLUMN IF NOT EXISTS tax_removable boolean NOT NULL DEFAULT false;

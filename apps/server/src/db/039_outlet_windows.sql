-- Menu time windows per outlet (backend handout, section 6): orderable hours per day, per menu / category / item, on the outlet's own clock.
ALTER TABLE outlets ADD COLUMN IF NOT EXISTS timezone text;
ALTER TABLE outlets ADD COLUMN IF NOT EXISTS windows  jsonb;

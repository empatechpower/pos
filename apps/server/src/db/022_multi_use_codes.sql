-- A testing code can enrol several devices (up to max_uses) before it runs out. Ordinary codes stay one-use.
ALTER TABLE enrollment_codes ADD COLUMN IF NOT EXISTS max_uses integer NOT NULL DEFAULT 1;
ALTER TABLE enrollment_codes ADD COLUMN IF NOT EXISTS uses integer NOT NULL DEFAULT 0;

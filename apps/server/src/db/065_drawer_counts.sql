-- A count of the drawer in the middle of a shift: what was counted against what the till expected at that moment.
CREATE TABLE IF NOT EXISTS drawer_counts (
  id             bigserial PRIMARY KEY,
  shift_id       text NOT NULL REFERENCES shifts(id),
  counted_cents  integer NOT NULL CHECK (counted_cents >= 0),
  expected_cents integer NOT NULL,
  denominations  jsonb NOT NULL DEFAULT '{}'::jsonb,
  staff_name     text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS drawer_counts_shift ON drawer_counts (shift_id);

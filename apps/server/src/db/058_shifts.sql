-- A cashier's shift on one till: which drawer, the opening float, what was counted at the end. Cash taken and given back is worked out
-- from the order events that carry the shift's id, so there is one record of the money.
CREATE TABLE IF NOT EXISTS shifts (
  id                   text PRIMARY KEY,
  merchant_id          text NOT NULL,
  outlet_id            text NOT NULL,
  device_id            text NOT NULL,
  staff_id             text NOT NULL,
  staff_code           text NOT NULL,
  staff_name           text NOT NULL,
  drawer               smallint NOT NULL CHECK (drawer IN (1, 2)),
  opening_float_cents  integer NOT NULL CHECK (opening_float_cents >= 0),
  opened_at            timestamptz NOT NULL DEFAULT now(),
  closed_at            timestamptz,
  closed_by_name       text,
  counted_cents        integer,
  expected_cents       integer,
  variance_cents       integer,
  note                 text
);
-- One open shift per person, and one open shift per drawer on a till.
CREATE UNIQUE INDEX IF NOT EXISTS shifts_one_open_per_staff ON shifts (merchant_id, staff_id) WHERE closed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS shifts_one_open_per_drawer ON shifts (merchant_id, device_id, drawer) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS shifts_recent ON shifts (merchant_id, opened_at DESC);

CREATE TABLE IF NOT EXISTS cash_moves (
  id           bigserial PRIMARY KEY,
  shift_id     text NOT NULL REFERENCES shifts(id),
  kind         text NOT NULL CHECK (kind IN ('in', 'out')),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  reason       text NOT NULL,
  staff_name   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cash_moves_shift ON cash_moves (shift_id);

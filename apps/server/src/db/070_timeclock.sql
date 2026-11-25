-- Staff attendance. A card (an RFID or NFC card read by a reader that types its number) clocks a person in and out without signing in to
-- the till; a staff code and PIN does the same for someone without a card. One row per spell of work; clock_out is NULL while it is open.
ALTER TABLE staff ADD COLUMN IF NOT EXISTS card_id text;
CREATE UNIQUE INDEX IF NOT EXISTS staff_card ON staff (merchant_id, card_id) WHERE card_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS time_entries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id text NOT NULL,
  outlet_id   text NOT NULL,
  staff_id    uuid NOT NULL REFERENCES staff(id),
  staff_name  text NOT NULL,
  clock_in    timestamptz NOT NULL DEFAULT now(),
  clock_out   timestamptz,
  in_method   text NOT NULL,           -- card | pin | telegram | manager
  out_method  text,
  in_device   text,
  out_device  text,
  note        text,
  edited_by   text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (clock_out IS NULL OR clock_out >= clock_in)
);
CREATE INDEX IF NOT EXISTS time_entries_staff ON time_entries (merchant_id, staff_id, clock_in DESC);
CREATE UNIQUE INDEX IF NOT EXISTS time_entries_one_open ON time_entries (merchant_id, staff_id) WHERE clock_out IS NULL;

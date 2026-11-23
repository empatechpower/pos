-- One row per dynamic PayNow QR we issue: what we expect to be paid, for which order, and until when.
-- The reference is unique and maps back to the order; a payment is claimed by at most one bank reference.
CREATE TABLE IF NOT EXISTS payment_expectations (
  payment_id          text PRIMARY KEY,
  seq                 bigserial UNIQUE,
  merchant_id         text NOT NULL,
  order_id            text NOT NULL,
  reference           text NOT NULL UNIQUE,
  outlet_code         text NOT NULL,
  channel             text NOT NULL,
  amount_cents        integer NOT NULL CHECK (amount_cents > 0),
  proxy_value         text NOT NULL,
  issued_at           timestamptz NOT NULL,
  expires_at          timestamptz NOT NULL,
  -- WAITING, PAID, EXPIRED (a newer QR replaced it). "Not found" is worked out from the clock, never stored.
  state               text NOT NULL DEFAULT 'WAITING',
  claimed_by_bank_ref text UNIQUE,
  payer_name          text,
  alert_email_id      text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payment_expectations_order ON payment_expectations (merchant_id, order_id);

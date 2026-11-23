-- Every bank alert we read, claimed or not. The bank's own transaction reference is the key, so one payment can never claim two orders.
CREATE TABLE IF NOT EXISTS payment_alerts (
  bank_ref            text PRIMARY KEY,
  merchant_id         text NOT NULL,
  amount_cents        integer NOT NULL,
  payer_name          text,
  account_ending      text,
  email_id            text,
  email_date          timestamptz NOT NULL,
  received_at         timestamptz NOT NULL DEFAULT now(),
  auth_results        text,
  -- CLAIMED (paid an order), UNASSIGNED (real money, no live QR: staff decide), RESOLVED (staff assigned or dismissed it)
  status              text NOT NULL,
  claimed_payment_id  text,
  resolution          text
);
CREATE INDEX IF NOT EXISTS payment_alerts_open ON payment_alerts (merchant_id, status);
ALTER TABLE payment_expectations ADD COLUMN IF NOT EXISTS receiving_account_ending text;

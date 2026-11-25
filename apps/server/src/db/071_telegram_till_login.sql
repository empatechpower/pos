-- Signing in at a till by scanning its QR code in Telegram. The till asks for a one-time code and shows it as a QR; the person's
-- Telegram (already linked to their staff login) approves it; the till then collects a session. Only a hash of the code is kept.
CREATE TABLE IF NOT EXISTS telegram_till_logins (
  nonce_hash  text PRIMARY KEY,
  merchant_id text NOT NULL,
  device_id   text NOT NULL,
  outlet_id   text NOT NULL,
  staff_id    uuid REFERENCES staff(id),
  approved_at timestamptz,
  used_at     timestamptz,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

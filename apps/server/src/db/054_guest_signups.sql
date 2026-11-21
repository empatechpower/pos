-- A guest who ticked "Keen to sign up as a member?" at checkout: an unverified, pending sign-up. It is NOT a member (no points, no welcome gift)
-- until the email is verified; the phone is kept for collecting the order only.
CREATE TABLE IF NOT EXISTS guest_signups (
  merchant_id text NOT NULL,
  email       text NOT NULL,
  phone       text,
  name        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, email)
);

-- Sign-in by other means than an emailed code: Google, Microsoft and a text message from the customer's phone.
-- A phone-only customer has no email, so email becomes optional (it stays unique when present).
ALTER TABLE members ALTER COLUMN email DROP NOT NULL;

CREATE TABLE IF NOT EXISTS member_identities (
  merchant_id text NOT NULL,
  provider    text NOT NULL,
  subject     text NOT NULL,
  member_id   uuid NOT NULL REFERENCES members(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, provider, subject)
);

-- Short-lived state for an in-flight OAuth sign-in (guards against forged callbacks, carries the PKCE verifier).
CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash  text PRIMARY KEY,
  merchant_id text NOT NULL,
  provider    text NOT NULL,
  verifier    text NOT NULL,
  expires_at  timestamptz NOT NULL
);

-- One-time ticket handed to the browser after a provider sign-in, traded once for a session (keeps tokens out of URLs).
CREATE TABLE IF NOT EXISTS login_tickets (
  ticket_hash text PRIMARY KEY,
  merchant_id text NOT NULL,
  member_id   uuid NOT NULL REFERENCES members(id),
  expires_at  timestamptz NOT NULL,
  used        boolean NOT NULL DEFAULT false
);

-- "Reverse SMS": the customer texts a code from their own phone; the number it comes from proves the number is theirs.
CREATE TABLE IF NOT EXISTS sms_challenges (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id text NOT NULL,
  phone       text NOT NULL,
  code        text NOT NULL,
  expires_at  timestamptz NOT NULL,
  verified_at timestamptz,
  claimed     boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sms_challenges_phone ON sms_challenges (merchant_id, phone, created_at);

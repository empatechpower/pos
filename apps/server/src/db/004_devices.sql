-- Enrolled devices (POS tills, kitchen screens, displays, hubs). A device holds a long-lived token;
-- only its hash is stored. Enrollment codes are one-time and short-lived.
CREATE TABLE IF NOT EXISTS devices (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id  text NOT NULL,
  outlet_id    text NOT NULL,
  name         text NOT NULL,
  token_hash   text NOT NULL UNIQUE,
  active       boolean NOT NULL DEFAULT true,
  enrolled_by  uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz
);

CREATE TABLE IF NOT EXISTS enrollment_codes (
  code_hash   text PRIMARY KEY,
  merchant_id text NOT NULL,
  outlet_id   text NOT NULL,
  device_id   uuid REFERENCES devices(id),  -- set when re-issuing a token for an existing device
  created_by  uuid,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);

-- A limited "agent" role (an AI helper or script) and the API keys it signs in with. Only a hash of each key is stored.
ALTER TABLE staff DROP CONSTRAINT IF EXISTS staff_role_check;
ALTER TABLE staff ADD CONSTRAINT staff_role_check CHECK (role IN ('cashier','manager','owner','agent'));

CREATE TABLE IF NOT EXISTS agent_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id  text NOT NULL,
  staff_id     uuid NOT NULL REFERENCES staff(id),
  name         text NOT NULL,
  key_hash     text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

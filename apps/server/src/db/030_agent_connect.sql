-- One-time codes a merchant gives to an agent (for example Muse) so it can link itself to their shop. Only a hash is stored.
CREATE TABLE IF NOT EXISTS agent_connect_codes (
  code_hash   text PRIMARY KEY,
  merchant_id text NOT NULL,
  created_by  uuid NOT NULL REFERENCES staff(id),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);

-- Staff accounts, sessions and the audit trail. Money actions are attributed to a staff member.
CREATE TABLE IF NOT EXISTS staff (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id     text NOT NULL,
  code            text NOT NULL,                 -- what the person types, e.g. "S01"
  name            text NOT NULL,
  role            text NOT NULL CHECK (role IN ('cashier','manager','owner')),
  pin_hash        text NOT NULL,                 -- scrypt, salted
  active          boolean NOT NULL DEFAULT true,
  failed_attempts int  NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, code)
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,                   -- sha256 of the token; the token itself is never stored
  staff_id   uuid NOT NULL REFERENCES staff(id),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          bigserial PRIMARY KEY,
  merchant_id text NOT NULL,
  staff_id    uuid,
  action      text NOT NULL,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_merchant_time ON audit_log (merchant_id, created_at DESC);

ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS staff_id uuid;

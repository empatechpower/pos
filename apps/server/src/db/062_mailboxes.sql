-- A merchant's own mailbox that the bank's PayNow alerts arrive in. The password or login token is stored sealed (see secrets.ts), never as written.
CREATE TABLE IF NOT EXISTS mailboxes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id  text NOT NULL,
  label        text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('imap','gmail')),
  host         text,
  port         integer,
  username     text,
  secret_enc   text NOT NULL,
  last_ok_at   timestamptz,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mailboxes_merchant ON mailboxes (merchant_id);

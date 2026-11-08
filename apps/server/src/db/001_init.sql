-- Credit ledger. Entries are immutable; wallet.balance_cents is a projection kept in the same
-- transaction as the entry, and can always be rebuilt from ledger_entries.
CREATE TABLE IF NOT EXISTS wallets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id   text   NOT NULL,
  customer_id   text   NOT NULL,
  balance_cents bigint NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, customer_id)
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id       uuid   NOT NULL REFERENCES wallets(id),
  kind            text   NOT NULL CHECK (kind IN ('topup','spend','refund','adjust')),
  amount_cents    bigint NOT NULL CHECK (amount_cents <> 0), -- signed: + adds credit, - removes
  balance_after   bigint NOT NULL,
  idempotency_key text   NOT NULL,
  order_id        text,
  outlet_id       text,
  device_id       text,
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (wallet_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS ledger_entries_wallet_time ON ledger_entries (wallet_id, created_at);

-- Customer accounts, email sign-in codes, sessions, and the points ledger.
CREATE TABLE IF NOT EXISTS members (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id    text NOT NULL,
  email          text NOT NULL,
  name           text,
  phone          text,
  points_balance bigint NOT NULL DEFAULT 0 CHECK (points_balance >= 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, email)
);

CREATE TABLE IF NOT EXISTS member_challenges (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id text NOT NULL,
  email       text NOT NULL,
  code_hash   text NOT NULL,
  expires_at  timestamptz NOT NULL,
  attempts    int NOT NULL DEFAULT 0,
  used        boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS member_challenges_email ON member_challenges (merchant_id, email, created_at);

CREATE TABLE IF NOT EXISTS member_sessions (
  token_hash  text PRIMARY KEY,
  merchant_id text NOT NULL,
  member_id   uuid NOT NULL REFERENCES members(id),
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Append-only. points is signed; members.points_balance is a projection kept in the same transaction.
CREATE TABLE IF NOT EXISTS points_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id       uuid NOT NULL REFERENCES members(id),
  kind            text NOT NULL CHECK (kind IN ('welcome','earn','redeem','refund','adjust')),
  points          bigint NOT NULL CHECK (points <> 0),
  balance_after   bigint NOT NULL,
  idempotency_key text NOT NULL,
  order_id        text,
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (member_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS points_entries_member ON points_entries (member_id, created_at);

-- What each member order spent and earned, so each happens exactly once.
CREATE TABLE IF NOT EXISTS member_orders (
  order_id         text PRIMARY KEY,
  merchant_id      text NOT NULL,
  member_id        uuid NOT NULL REFERENCES members(id),
  points_redeemed  bigint NOT NULL DEFAULT 0,
  redeem_refunded  boolean NOT NULL DEFAULT false,
  earned_points    bigint,
  created_at       timestamptz NOT NULL DEFAULT now()
);

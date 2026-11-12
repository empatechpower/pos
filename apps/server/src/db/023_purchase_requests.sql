-- One row per checkout attempt, keyed by an idempotency key the customer's phone makes for that attempt.
-- A retry with the same key gets the same result (never a second debit); the same key with different content is refused.
CREATE TABLE IF NOT EXISTS purchase_requests (
  merchant_id  text NOT NULL,
  idem_key     text NOT NULL,
  request_hash text NOT NULL,
  member_id    text NOT NULL,
  order_id     text NOT NULL,
  state        text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','done')),
  result       jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, idem_key)
);

-- Promotional prices that run for a stretch of time (Q&A A-3). Pricebooks keep the real prices; these only override while running.
CREATE TABLE IF NOT EXISTS price_overrides (
  merchant_id  text NOT NULL,
  id           text NOT NULL,
  title        text NOT NULL,
  product_id   text NOT NULL,
  pricebook_id text,
  price_cents  integer NOT NULL CHECK (price_cents >= 0),
  starts_at    timestamptz NOT NULL,
  ends_at      timestamptz NOT NULL,
  PRIMARY KEY (merchant_id, id)
);

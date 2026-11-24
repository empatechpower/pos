-- Shift close in full: the cash count by denomination (optional), what the cashier said about each order still open, who approved a variance,
-- and the optional Day-End close a merchant may switch on.
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS opening_denoms jsonb;
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS closing_denoms jsonb;
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS dispositions jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS approved_by_name text;

CREATE TABLE IF NOT EXISTS day_ends (
  id             bigserial PRIMARY KEY,
  merchant_id    text NOT NULL,
  business_date  text NOT NULL,
  closed_by_name text NOT NULL,
  shifts         integer NOT NULL,
  orders         integer NOT NULL,
  sales_cents    bigint NOT NULL,
  variance_cents bigint NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS day_ends_recent ON day_ends (merchant_id, created_at DESC);

-- A member's coupons and vouchers. One use each; a coupon spent on an order that is cancelled is released again.
CREATE TABLE IF NOT EXISTS member_coupons (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id     text NOT NULL,
  member_id       uuid NOT NULL REFERENCES members(id),
  title           text NOT NULL,
  amount_cents    bigint NOT NULL CHECK (amount_cents > 0),
  -- Counted on the ITEMS subtotal only: before service charge and tax, deposits excluded.
  min_spend_cents bigint NOT NULL DEFAULT 0 CHECK (min_spend_cents >= 0),
  expires_at      timestamptz,
  source_key      text NOT NULL,            -- 'welcome' etc., so a grant can never happen twice
  used_order_id   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (member_id, source_key)
);
CREATE INDEX IF NOT EXISTS member_coupons_member ON member_coupons (member_id);

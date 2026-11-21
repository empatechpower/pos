-- Coupons and personal points on a tab (Spec 12.4 D3, 12.7, 8.2).
-- A coupon any person on the tab applies from their own wallet: it is shared pro-rata across the payers. Set before the first payment.
CREATE TABLE IF NOT EXISTS tab_coupons (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tab_id           uuid NOT NULL,
  participant_id   uuid NOT NULL,           -- the owner: only they can remove it
  member_id        text NOT NULL,
  member_coupon_id text NOT NULL,
  title            text NOT NULL,
  amount_cents     integer NOT NULL,
  min_spend_cents  integer NOT NULL DEFAULT 0,
  applied_at       timestamptz NOT NULL DEFAULT now(),
  removed_at       timestamptz
);
CREATE INDEX IF NOT EXISTS tab_coupons_tab ON tab_coupons (tab_id) WHERE removed_at IS NULL;

-- A payer's own points, spent against their own share: the cash they pay is the amount, the points are recorded beside it.
ALTER TABLE tab_payments ADD COLUMN IF NOT EXISTS points_used integer NOT NULL DEFAULT 0;
ALTER TABLE tab_payments DROP CONSTRAINT IF EXISTS tab_payments_amount_cents_check;
ALTER TABLE tab_payments ADD CONSTRAINT tab_payments_amount_cents_check CHECK (amount_cents >= 0);
ALTER TABLE tab_payments DROP CONSTRAINT IF EXISTS tab_payments_cash_or_points;
ALTER TABLE tab_payments ADD CONSTRAINT tab_payments_cash_or_points CHECK (amount_cents > 0 OR points_used > 0);

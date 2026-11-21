-- Promo codes (backend handout, section 10): typed codes in addition to wallet coupons.
CREATE TABLE IF NOT EXISTS promo_codes (
  merchant_id    text NOT NULL,
  code           text NOT NULL,                       -- upper case
  title          text NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('percent','amount')),
  value          integer NOT NULL CHECK (value > 0),  -- percent (1-100) or cents
  min_spend_cents integer NOT NULL DEFAULT 0,         -- on the items subtotal before service charge, tax and deposits
  starts_at      timestamptz,
  ends_at        timestamptz,
  max_uses       integer,                             -- null = unlimited
  max_per_member integer,                             -- null = unlimited
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, code)
);

-- One row per order that used a code. A cancelled order gives its use back (reversed_at).
CREATE TABLE IF NOT EXISTS promo_redemptions (
  merchant_id text NOT NULL,
  code        text NOT NULL,
  order_id    text NOT NULL,
  member_id   text,
  discount_cents integer NOT NULL,
  redeemed_at timestamptz NOT NULL DEFAULT now(),
  reversed_at timestamptz,
  PRIMARY KEY (merchant_id, order_id)
);
CREATE INDEX IF NOT EXISTS promo_redemptions_code ON promo_redemptions (merchant_id, code) WHERE reversed_at IS NULL;

-- Merchant setting: may a code be used together with a wallet coupon? Default no (one code or coupon per order; points are always independent).
CREATE TABLE IF NOT EXISTS promo_settings (
  merchant_id        text PRIMARY KEY,
  stack_with_coupons boolean NOT NULL DEFAULT false
);

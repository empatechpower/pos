-- One switch per merchant: while credit_frozen is true, member credit cannot be spent (online orders and staff credit payments are refused).
-- Balances, top-ups and refunds are unaffected. Off by default.
CREATE TABLE IF NOT EXISTS shop_settings (
  merchant_id   text PRIMARY KEY,
  credit_frozen boolean NOT NULL DEFAULT false
);

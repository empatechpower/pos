-- Daily counters (online order numbers restart each day) and the merchant's shop look.
CREATE TABLE IF NOT EXISTS counters (
  merchant_id text NOT NULL,
  name        text NOT NULL,
  day         date NOT NULL,
  value       int  NOT NULL,
  PRIMARY KEY (merchant_id, name, day)
);

CREATE TABLE IF NOT EXISTS merchant_brand (
  merchant_id   text PRIMARY KEY,
  primary_color text NOT NULL DEFAULT '#ea7016',
  accent_color  text NOT NULL DEFAULT '#fdeee0',
  logo          bytea,
  logo_type     text,
  logo_version  int NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

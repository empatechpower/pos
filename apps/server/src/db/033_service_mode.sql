-- Service mode per outlet: 'qsr' = quick service (no table), 'tsr' = table service (a table is required).
-- NULL means "not chosen yet": the outlet follows the old rule (a table list in SHOP_TABLES means table service).
ALTER TABLE outlets ADD COLUMN IF NOT EXISTS service_mode text;
DO $$ BEGIN
  ALTER TABLE outlets ADD CONSTRAINT outlets_service_mode_check CHECK (service_mode IN ('qsr', 'tsr'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Options the owner can switch on or off without a deploy (service charge, tax).
CREATE TABLE IF NOT EXISTS merchant_settings (
  merchant_id text NOT NULL,
  key         text NOT NULL,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, key)
);

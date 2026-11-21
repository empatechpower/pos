-- Customer display screens paired to a till (a separate tablet or monitor running the /display page). The screen holds a secret; only its hash is kept.
-- Until a till links it with the short code, it is unlinked and its code expires after 15 minutes.
CREATE TABLE IF NOT EXISTS display_screens (
  merchant_id    text NOT NULL,
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  secret_hash    text NOT NULL,
  code           text,
  till_device_id uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  linked_at      timestamptz,
  last_seen      timestamptz,
  PRIMARY KEY (merchant_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS display_screens_secret ON display_screens (secret_hash);
CREATE UNIQUE INDEX IF NOT EXISTS display_screens_code ON display_screens (merchant_id, code) WHERE code IS NOT NULL;

-- What each till last said the customer screen should show.
CREATE TABLE IF NOT EXISTS display_state (
  merchant_id    text NOT NULL,
  till_device_id uuid NOT NULL,
  state          jsonb NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, till_device_id)
);

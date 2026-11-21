-- Scheduled pickup (backend handout, section 7): an outlet can take orders for a chosen time, held until the slot less the prep time.
ALTER TABLE outlets ADD COLUMN IF NOT EXISTS scheduling_on boolean NOT NULL DEFAULT false;
ALTER TABLE outlets ADD COLUMN IF NOT EXISTS slot_interval_minutes integer NOT NULL DEFAULT 15;
ALTER TABLE outlets ADD COLUMN IF NOT EXISTS schedule_days_ahead integer NOT NULL DEFAULT 3;

-- The orders waiting for their moment. The row is what the scheduler reads, so a restart loses nothing.
CREATE TABLE IF NOT EXISTS scheduled_orders (
  merchant_id text NOT NULL,
  order_id    text NOT NULL,
  outlet_id   text NOT NULL,
  fire_at     bigint NOT NULL,
  fired       boolean NOT NULL DEFAULT false,
  PRIMARY KEY (merchant_id, order_id)
);
CREATE INDEX IF NOT EXISTS scheduled_orders_due ON scheduled_orders (merchant_id, fire_at) WHERE NOT fired;

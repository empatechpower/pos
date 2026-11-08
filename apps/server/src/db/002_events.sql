-- Order event log. server_seq is the cursor devices pull by. Appends take a per-outlet advisory
-- lock so sequence numbers become visible in order; otherwise a device could advance its cursor
-- past an event that commits a moment later and never receive it.
CREATE TABLE IF NOT EXISTS events (
  server_seq  bigserial PRIMARY KEY,
  id          text NOT NULL UNIQUE,
  merchant_id text NOT NULL,
  outlet_id   text NOT NULL,
  order_id    text NOT NULL,
  device_id   text NOT NULL,
  type        text NOT NULL,
  body        jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_outlet_seq ON events (merchant_id, outlet_id, server_seq);

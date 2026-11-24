-- Every time a staff member opens an order, even just to look: who, when, and from where. Nothing here is ever edited or removed.
CREATE TABLE IF NOT EXISTS order_views (
  id           bigserial PRIMARY KEY,
  merchant_id  text NOT NULL,
  order_id     text NOT NULL,
  staff_id     text NOT NULL,
  staff_name   text NOT NULL,
  staff_role   text NOT NULL,
  device_id    text,
  seen_in      text NOT NULL DEFAULT '',
  -- When the person opened it (a till that was offline reports this later) and when we heard about it.
  viewed_at    timestamptz NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS order_views_order ON order_views (merchant_id, order_id, viewed_at);

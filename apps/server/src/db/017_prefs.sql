-- What a member wants to hear about, and a record of the emails already sent so none goes out twice.
ALTER TABLE members ADD COLUMN IF NOT EXISTS pref_order_updates boolean NOT NULL DEFAULT true;
ALTER TABLE members ADD COLUMN IF NOT EXISTS pref_promos boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS member_notices (
  order_id   text NOT NULL,
  kind       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (order_id, kind)
);

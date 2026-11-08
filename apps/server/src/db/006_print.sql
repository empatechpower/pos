-- Printers and the durable print queue. A job is stored as final printer bytes, so whatever delivers
-- it (a hub app, a small agent) needs no knowledge of receipts or label languages.
CREATE TABLE IF NOT EXISTS printers (
  merchant_id     text NOT NULL,
  id              text NOT NULL,
  name            text NOT NULL,
  outlet_id       text NOT NULL,
  language        text NOT NULL CHECK (language IN ('escpos','zpl','epl')),
  roles           text[] NOT NULL,                     -- receipt | kitchen | label
  categories      text[] NOT NULL DEFAULT '{}',        -- kitchen/label: only these menu categories ({} = the rest)
  width_chars     int  NOT NULL DEFAULT 42,
  drawer          boolean NOT NULL DEFAULT false,      -- open the cash drawer with cash receipts
  label_width_mm  int,
  label_height_mm int,
  dpi             int  NOT NULL DEFAULT 203,
  connection      jsonb NOT NULL,                      -- { "host": "...", "port": 9100 }
  agent_device_id uuid,                                -- the hub/agent that delivers to it (null = any)
  active          boolean NOT NULL DEFAULT true,
  PRIMARY KEY (merchant_id, id)
);

CREATE TABLE IF NOT EXISTS print_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id     text NOT NULL,
  outlet_id       text NOT NULL,
  printer_id      text NOT NULL,
  doc_type        text NOT NULL CHECK (doc_type IN ('receipt','kitchen','label','test')),
  order_id        text,
  dedupe_key      text NOT NULL,
  payload         bytea NOT NULL,
  status          text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','leased','done','failed')),
  attempts        int  NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  leased_until    timestamptz,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS print_jobs_pending ON print_jobs (merchant_id, status, next_attempt_at);

-- Which order lines have already gone to the kitchen / label printers, so adding to an open tab
-- prints only the new lines.
CREATE TABLE IF NOT EXISTS printed_lines (
  merchant_id text NOT NULL,
  order_id    text NOT NULL,
  line_id     text NOT NULL,
  doc_type    text NOT NULL,
  PRIMARY KEY (merchant_id, order_id, line_id, doc_type)
);

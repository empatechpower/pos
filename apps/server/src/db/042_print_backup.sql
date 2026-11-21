-- Kitchen printer offline chain (developer package, C-4): a printer can name a backup. When a kitchen ticket cannot be delivered after a few quick
-- retries it is sent to the backup and staff are told where it went; if that keeps happening, staff are prompted to make the route permanent.
ALTER TABLE printers ADD COLUMN IF NOT EXISTS backup_printer_id text;
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS rerouted_to text;
ALTER TABLE print_jobs DROP CONSTRAINT IF EXISTS print_jobs_status_check;
ALTER TABLE print_jobs ADD CONSTRAINT print_jobs_status_check CHECK (status IN ('queued','leased','done','failed','unconfirmed','rerouted'));

-- What staff and HQ need to know about printing. One row per event; the Printers screen lists the open ones, and each is also sent to linked staff.
CREATE TABLE IF NOT EXISTS print_alerts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id text NOT NULL,
  outlet_id   text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('rerouted','no_backup','repeated_reroute')),
  printer_id  text NOT NULL,
  backup_id   text,
  job_id      uuid,
  detail      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX IF NOT EXISTS print_alerts_open ON print_alerts (merchant_id, resolved_at, created_at DESC);

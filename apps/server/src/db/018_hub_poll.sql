-- When a device last asked for print jobs: the sign that a print hub is alive and connected.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_print_poll_at timestamptz;

-- A table's page for the waiter now has a real state: when it was recorded, when staff acknowledged it, and when it was escalated.
ALTER TABLE tabs ADD COLUMN IF NOT EXISTS paged_at timestamptz;
ALTER TABLE tabs ADD COLUMN IF NOT EXISTS page_acked_at timestamptz;
ALTER TABLE tabs ADD COLUMN IF NOT EXISTS page_escalated_at timestamptz;

-- Whether a printer prints the queue number on its tickets and receipts. On by default.
ALTER TABLE printers ADD COLUMN IF NOT EXISTS show_queue boolean NOT NULL DEFAULT true;

-- The queue number is now off by default on every printer (a printer's "Print the queue number" setting can switch it on).
-- Printers that already exist are turned off too, once, as part of this change.
ALTER TABLE printers ALTER COLUMN show_queue SET DEFAULT false;
UPDATE printers SET show_queue = false;

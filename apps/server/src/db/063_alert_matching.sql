-- How each bank alert was matched to a QR: by the order's reference in the bank's remarks (certain), or only by amount, account and time (probable).
ALTER TABLE payment_alerts ADD COLUMN IF NOT EXISTS matched_by text;
ALTER TABLE payment_alerts ADD COLUMN IF NOT EXISTS remarks text;
ALTER TABLE payment_expectations ADD COLUMN IF NOT EXISTS matched_by text;

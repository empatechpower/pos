-- The phone number of the SIM in a tablet running Rezein: the number customers text to sign in.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS sms_number text;

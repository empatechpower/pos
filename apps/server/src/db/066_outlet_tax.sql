-- Where an outlet is, and its tax registration. The country chooses the tax pack (rate, rounding, whether tax can be taken off): there is
-- no separate setting that overrides it. The GST registration number and the business number print on the receipt; with a GST number
-- the receipt is a tax invoice.
ALTER TABLE outlets ADD COLUMN IF NOT EXISTS country text NOT NULL DEFAULT 'SG';
ALTER TABLE outlets ADD COLUMN IF NOT EXISTS gst_reg_no text;
ALTER TABLE outlets ADD COLUMN IF NOT EXISTS uen text;

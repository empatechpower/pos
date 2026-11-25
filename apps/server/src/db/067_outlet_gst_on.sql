-- Whether this outlet charges tax. NULL = it follows the brand's own switch (Manager > Outlets > Pricing options), as before.
-- A brand whose outlets are not all registered for GST sets it outlet by outlet.
ALTER TABLE outlets ADD COLUMN IF NOT EXISTS gst_on boolean;

-- A staff member can sign in with their phone number and PIN. Kept as +country-code digits; one person per number in a shop.
ALTER TABLE staff ADD COLUMN IF NOT EXISTS phone text;
CREATE UNIQUE INDEX IF NOT EXISTS staff_phone_uq ON staff (merchant_id, phone) WHERE phone IS NOT NULL;

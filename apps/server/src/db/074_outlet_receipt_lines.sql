-- The rest of an outlet's receipt profile (decision Q44): its own closing lines (a thank-you, a promotion) and a customer service line.
ALTER TABLE outlets ADD COLUMN IF NOT EXISTS receipt_footer text;
ALTER TABLE outlets ADD COLUMN IF NOT EXISTS customer_service text;

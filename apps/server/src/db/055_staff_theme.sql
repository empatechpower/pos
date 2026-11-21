-- A staff member's own colour for the staff screens (Q&A F-2). NULL = follow the merchant's theme.
ALTER TABLE staff ADD COLUMN IF NOT EXISTS theme_primary text;

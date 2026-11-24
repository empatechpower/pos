-- A staff member's own screen choices (which side the menu sits, text size). They follow the person to any till.
ALTER TABLE staff ADD COLUMN IF NOT EXISTS prefs jsonb NOT NULL DEFAULT '{}'::jsonb;

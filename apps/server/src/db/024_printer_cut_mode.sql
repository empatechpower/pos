-- How a kitchen printer cuts its tickets:
--   grouped  one cut for each different item, identical items (same product and same modifiers) added together (the default)
--   unit     one cut for every single item, like a label
--   category one cut for each category, with the identical items added together
ALTER TABLE printers ADD COLUMN IF NOT EXISTS cut_mode text NOT NULL DEFAULT 'grouped';

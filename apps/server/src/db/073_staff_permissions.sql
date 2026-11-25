-- One person differing from their role: permissions given to them on top of it, and permissions taken away from it.
ALTER TABLE staff ADD COLUMN IF NOT EXISTS perm_allow text[] NOT NULL DEFAULT '{}';
ALTER TABLE staff ADD COLUMN IF NOT EXISTS perm_deny  text[] NOT NULL DEFAULT '{}';

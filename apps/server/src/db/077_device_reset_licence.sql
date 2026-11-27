-- A device an owner disconnected "and reset": the next time it calls the server, its browser is told to clear this app's copy and
-- stored data, so it opens fresh on the latest version (a phone stuck on an old copy is freed this way).
ALTER TABLE devices ADD COLUMN IF NOT EXISTS wipe_requested boolean NOT NULL DEFAULT false;

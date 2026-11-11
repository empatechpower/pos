-- Raster mode: the ticket is drawn as a picture, so any script and logo prints the same on any ESC/POS printer.
ALTER TABLE printers ADD COLUMN IF NOT EXISTS raster boolean NOT NULL DEFAULT false;

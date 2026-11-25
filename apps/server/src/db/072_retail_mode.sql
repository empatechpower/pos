-- A third service mode: retail (a shop that sells by scanning barcodes; no tables, no kitchen). One app serves all three (handout section 1).
ALTER TABLE outlets DROP CONSTRAINT IF EXISTS outlets_service_mode_check;
ALTER TABLE outlets ADD CONSTRAINT outlets_service_mode_check CHECK (service_mode IN ('qsr', 'tsr', 'retail'));

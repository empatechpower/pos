-- Outlet coordinates (developer package G-2): the merchant supplies them at onboarding; distance and sorting by distance switch on when they exist.
ALTER TABLE outlets ADD COLUMN IF NOT EXISTS latitude  double precision;
ALTER TABLE outlets ADD COLUMN IF NOT EXISTS longitude double precision;

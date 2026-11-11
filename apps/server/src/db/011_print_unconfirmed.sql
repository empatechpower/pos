-- Addendum 9.3: when delivery is ambiguous (the printer may already have the job) the job is parked as
-- 'unconfirmed' for a person to reprint deliberately. It is never silently printed a second time.
ALTER TABLE print_jobs DROP CONSTRAINT IF EXISTS print_jobs_status_check;
ALTER TABLE print_jobs ADD CONSTRAINT print_jobs_status_check CHECK (status IN ('queued','leased','done','failed','unconfirmed'));

-- Opt-in commission recording per channel (Q&A A-5). NULL = this merchant does not record commission for the channel.
ALTER TABLE channels ADD COLUMN IF NOT EXISTS commission_rate_pct numeric;

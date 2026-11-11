-- Stamp cards: a running count per member, and a flag so each order stamps once.
CREATE TABLE IF NOT EXISTS member_stamps (
  member_id uuid PRIMARY KEY REFERENCES members(id),
  count     int NOT NULL DEFAULT 0 CHECK (count >= 0),
  cards_completed int NOT NULL DEFAULT 0
);
ALTER TABLE member_orders ADD COLUMN IF NOT EXISTS stamped boolean NOT NULL DEFAULT false;

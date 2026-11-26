-- Gift cards: a balance that is loaded, spent and refunded against a code. Kept apart from member credit (wallets), so the two never mix in a report.
-- Entries are immutable; gift_cards.balance_cents is a projection kept in the same transaction as the entry, and can always be rebuilt from them.
CREATE TABLE IF NOT EXISTS gift_cards (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id   text   NOT NULL,
  code          text   NOT NULL,
  balance_cents bigint NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  active        boolean NOT NULL DEFAULT true,
  outlet_id     text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, code)
);
CREATE TABLE IF NOT EXISTS gift_card_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id         uuid   NOT NULL REFERENCES gift_cards(id),
  kind            text   NOT NULL CHECK (kind IN ('load','redeem','refund','adjust')),
  amount_cents    bigint NOT NULL CHECK (amount_cents <> 0), -- signed: + adds to the card, - takes from it
  balance_after   bigint NOT NULL,
  idempotency_key text   NOT NULL,
  order_id        text,
  outlet_id       text,
  device_id       text,
  staff_id        uuid,
  tender          text,  -- how a load was paid for (cash, card, ...), for the day's reconciliation
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (card_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS gift_card_entries_card_time ON gift_card_entries (card_id, created_at);

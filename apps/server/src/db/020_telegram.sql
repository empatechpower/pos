-- Staff who have linked their Telegram account to the shop's bot, and the short-lived codes used to link
-- (kind 'link') and to open the web editor from Telegram (kind 'web'). Only hashes of codes are stored.
CREATE TABLE IF NOT EXISTS telegram_links (
  merchant_id text   NOT NULL,
  telegram_id bigint NOT NULL,
  chat_id     bigint NOT NULL,
  staff_id    uuid   NOT NULL REFERENCES staff(id),
  name        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, telegram_id)
);

CREATE TABLE IF NOT EXISTS telegram_codes (
  code_hash   text PRIMARY KEY,
  merchant_id text NOT NULL,
  staff_id    uuid NOT NULL REFERENCES staff(id),
  kind        text NOT NULL CHECK (kind IN ('link','web')),
  target      text,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);

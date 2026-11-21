-- Tab & Split & Pay (Spec 12 and 13, Addendum 2.4, 3, 4, 5, 6). Table service: a table's orders are Rounds on one shared Tab; people pay the Tab down.
-- Off per outlet until the manager turns it on ("table service uses a shared tab"), so an existing table-service shop behaves as before.
ALTER TABLE outlets ADD COLUMN IF NOT EXISTS tab_service boolean NOT NULL DEFAULT false;
-- D2: how a custom amount is applied: mark items paid oldest round first, or only reduce what remains.
ALTER TABLE outlets ADD COLUMN IF NOT EXISTS tab_custom_allocation text NOT NULL DEFAULT 'oldest_first';

CREATE TABLE IF NOT EXISTS tabs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id     text NOT NULL,
  outlet_id       text NOT NULL,
  spot            text,                      -- the table; null for a bar tab (opened by its code)
  code            text NOT NULL,             -- the short check-in code, shown on the Tab screen
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  host_id         uuid,                      -- the first person who scanned
  version         integer NOT NULL DEFAULT 1,-- rises with every change, so a quote can tell it is stale
  released_at     timestamptz,               -- the waiter's last release; rounds ordered after it start locked again
  bill_requested  boolean NOT NULL DEFAULT false,
  waiter_paged    boolean NOT NULL DEFAULT false,
  paged_kind      text,
  opened_at       timestamptz NOT NULL DEFAULT now(),
  closed_at       timestamptz,
  closed_reason   text,
  rewards_credited_at timestamptz            -- the exactly-once watermark (12.10)
);
CREATE UNIQUE INDEX IF NOT EXISTS tabs_open_spot ON tabs (merchant_id, outlet_id, spot) WHERE status='open' AND spot IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS tabs_open_code ON tabs (merchant_id, code) WHERE status='open';

CREATE TABLE IF NOT EXISTS tab_participants (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tab_id       uuid NOT NULL,
  display_name text NOT NULL,
  member_id    text,                         -- a signed-in member (verified by the server, never taken from the client)
  token_hash   text NOT NULL,                -- the guest credential: participant id and this token are checked together
  ord          integer NOT NULL,             -- join order: the earliest remaining person stands in when the Host has left
  joined_at    timestamptz NOT NULL DEFAULT now(),
  left_at      timestamptz,
  claimed_by   text                          -- a guest who signed up and claimed their entitlement (single use)
);
CREATE INDEX IF NOT EXISTS tab_participants_tab ON tab_participants (tab_id);

CREATE TABLE IF NOT EXISTS tab_rounds (
  tab_id         uuid NOT NULL,
  order_id       text NOT NULL,
  round_no       integer NOT NULL,
  participant_id uuid NOT NULL,              -- who ordered it
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tab_id, order_id)
);

-- "Share this item": a line split between the people chosen.
CREATE TABLE IF NOT EXISTS tab_line_shares (
  tab_id         uuid NOT NULL,
  line_id        text NOT NULL,
  participant_id uuid NOT NULL,
  ord            integer NOT NULL,
  PRIMARY KEY (tab_id, line_id, participant_id)
);

-- A frozen quote (Addendum 2.4): the full breakdown at issue time. A payment is taken against it, or it is rejected and a new one issued.
CREATE TABLE IF NOT EXISTS tab_quotes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tab_id         uuid NOT NULL,
  participant_id uuid NOT NULL,
  version        integer NOT NULL,
  mode           text NOT NULL,
  params         jsonb NOT NULL,
  amount_cents   integer NOT NULL,
  breakdown      jsonb NOT NULL,
  issued_at      timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  used           boolean NOT NULL DEFAULT false
);

-- One row per payment attempt, with its state history. A reservation counts against what is owed until it completes, is cancelled or is rejected.
CREATE TABLE IF NOT EXISTS tab_payments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tab_id         uuid NOT NULL,
  payer_id       uuid NOT NULL,              -- who actually paid: the session identity, never a client-supplied one
  for_id         uuid,                       -- whose share it is when the payer pays for someone else
  mode           text NOT NULL,
  method         text NOT NULL,              -- credit | counter | cash | card | paynow
  amount_cents   integer NOT NULL CHECK (amount_cents > 0),
  status         text NOT NULL CHECK (status IN ('reserved','completed','rejected','cancelled','unknown')),
  quote_id       uuid,
  idem_key       text NOT NULL,
  host_keep      boolean NOT NULL DEFAULT false,
  provider_ref   text,
  alloc          jsonb NOT NULL,             -- what it settled, immutable once made
  staff_id       text,                       -- present only for a payment a staff member recorded (cash at the counter, a manual fallback)
  history        jsonb NOT NULL DEFAULT '[]',
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz,
  UNIQUE (tab_id, idem_key)
);

-- Which units a payment has spoken for. The key makes a double claim impossible at the database, whatever the application does.
CREATE TABLE IF NOT EXISTS tab_claims (
  tab_id     uuid NOT NULL,
  line_id    text NOT NULL,
  idx        integer NOT NULL,
  payment_id uuid NOT NULL,
  PRIMARY KEY (tab_id, line_id, idx)
);

-- What a person without an account earned: recorded on the tab, no wallet invented for them (12.10). A guest who signs up can claim it before settlement.
CREATE TABLE IF NOT EXISTS tab_entitlements (
  tab_id         uuid NOT NULL,
  participant_id uuid NOT NULL,
  points         integer NOT NULL,
  credited_to    text,
  PRIMARY KEY (tab_id, participant_id)
);

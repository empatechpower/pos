-- Tab money safety (Addendum 4.4 duplicate-payment exception, 6.5 refunds and reward reversals) and staff-added items.

-- A payment record the staff replaced with a manual one while its outcome was unknown. It is kept, flagged, never netted off.
ALTER TABLE tab_payments DROP CONSTRAINT IF EXISTS tab_payments_status_check;
ALTER TABLE tab_payments ADD CONSTRAINT tab_payments_status_check CHECK (status IN ('reserved','completed','rejected','cancelled','unknown','superseded'));
ALTER TABLE tab_payments ADD COLUMN IF NOT EXISTS superseded_by uuid;
ALTER TABLE tab_payments ADD COLUMN IF NOT EXISTS manual_ref text;
ALTER TABLE tab_payments ADD COLUMN IF NOT EXISTS refunded_cents integer NOT NULL DEFAULT 0;

-- Raised for staff when money may have been taken twice (a provider success after a manual payment for the same liability) or taken for a payment
-- that no longer exists. Resolved by hand with a note; the system never silently nets the two off.
CREATE TABLE IF NOT EXISTS tab_exceptions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tab_id             uuid NOT NULL,
  kind               text NOT NULL CHECK (kind IN ('duplicate_payment','late_success')),
  payment_id         uuid NOT NULL,          -- the integrated attempt that succeeded
  related_payment_id uuid,                   -- the manual payment that already settled the same liability
  amount_cents       integer NOT NULL,
  provider_ref       text,
  detail             text NOT NULL,
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  resolved_at        timestamptz,
  resolved_by        text,
  resolution         text
);
CREATE UNIQUE INDEX IF NOT EXISTS tab_exceptions_once ON tab_exceptions (payment_id, kind);

-- What each payment earned when the tab settled, so a refund can reverse exactly that (6.5): one row per payment, routed to who received it.
CREATE TABLE IF NOT EXISTS tab_reward_credits (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tab_id         uuid NOT NULL,
  payment_id     uuid NOT NULL,
  beneficiary_id uuid NOT NULL,             -- the participant who received it (the payer, or the Host for a host-keep payment)
  member_id      text,                      -- the account credited; null = recorded on the tab only (a guest who never signed up)
  points         integer NOT NULL,
  reversed       integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tab_reward_credits_payment ON tab_reward_credits (payment_id);

CREATE TABLE IF NOT EXISTS tab_refunds (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tab_id       uuid NOT NULL,
  payment_id   uuid NOT NULL,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  reason       text NOT NULL,
  staff_id     text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Staff-added items sit on a Staff participant: "Unclaimed" until someone pays for them or the Host claims them.
ALTER TABLE tab_participants ADD COLUMN IF NOT EXISTS is_staff boolean NOT NULL DEFAULT false;

-- A reversal after a refund posts in full even if the points were already spent: the balance may go below zero and is offset by future earnings (6.5).
ALTER TABLE members DROP CONSTRAINT IF EXISTS members_points_balance_check;
ALTER TABLE points_entries DROP CONSTRAINT IF EXISTS points_entries_kind_check;
ALTER TABLE points_entries ADD CONSTRAINT points_entries_kind_check CHECK (kind IN ('welcome','earn','redeem','refund','adjust','reversal'));

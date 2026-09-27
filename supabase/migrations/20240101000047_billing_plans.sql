-- Migration 47: freemium/paid billing (PayHero M-Pesa STK push).
--
-- Three pieces:
--   creators.plan          — the single source of truth read by every feature
--                            gate (lib/entitlements.ts). Denormalized onto
--                            creators rather than derived from `subscriptions`
--                            on every request, because entitlement checks run
--                            on hot paths (ingestion, analyze, research chat)
--                            and must not cost a join + date comparison each
--                            time. `subscriptions` is the ledger of *why* it is
--                            what it is; `creators.plan` is the fast answer.
--   subscriptions           — one row per creator, current billing period.
--                            PayHero has no recurring-billing primitive (confirmed
--                            against their API: POST /payments is a one-off STK
--                            push), and M-Pesa STK inherently needs the user to
--                            enter their PIN each time, so there is no silent
--                            auto-renewal to model. current_period_end is when
--                            access lapses absent a new successful payment; a
--                            cron job (compute-insights-style) reads it to remind
--                            creators before it does and to downgrade after.
--   payhero_transactions    — append-only audit trail of every STK push attempt
--                            and the callback/poll that resolved it. Kept even
--                            for failed/cancelled attempts: a support conversation
--                            about "I paid but it says Free" needs this history,
--                            and a webhook payload is untrusted input until
--                            corroborated by a transaction-status poll, so both
--                            the claimed and confirmed status are recorded.
--
-- RLS on, no policies (service role only), matching every other creator-scoped
-- table in this project (see lib/api-auth.ts) — the app never lets a client
-- query these directly, only through requireCreator()-gated routes.

ALTER TABLE creators
  ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro'));

CREATE TABLE IF NOT EXISTS subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id uuid NOT NULL UNIQUE REFERENCES creators(id) ON DELETE CASCADE,
  plan text NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro')),
  status text NOT NULL DEFAULT 'inactive' CHECK (status IN ('inactive', 'active', 'past_due', 'canceled')),
  -- KES minor units (cents) so arithmetic never touches floats.
  amount_cents integer,
  phone_number text,
  current_period_start timestamptz,
  current_period_end timestamptz,
  -- Set once a renewal reminder has gone out for the CURRENT period, so the
  -- reminder job is idempotent across multiple runs per day.
  renewal_reminder_sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS payhero_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id uuid NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  -- What we generate and send to PayHero as external_reference — the join key
  -- between our row and PayHero's, since their reference is opaque to us until
  -- the callback/poll returns it.
  external_reference text NOT NULL UNIQUE,
  -- PayHero's own transaction reference, once known (present in most callback
  -- payloads; nullable because a push that never reached PayHero has none).
  payhero_reference text,
  plan text NOT NULL CHECK (plan IN ('pro')),
  amount_cents integer NOT NULL,
  phone_number text NOT NULL,
  -- 'pending' until either the callback fires or the status-poll fallback
  -- resolves it. 'confirmed' means a GET /transaction-status call — not just
  -- the raw callback body — reported success; see lib/payhero.ts. A callback
  -- is a hint to poll sooner, never proof by itself.
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'failed', 'cancelled')),
  raw_callback jsonb,
  raw_status_response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

ALTER TABLE payhero_transactions ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS payhero_transactions_creator_id_idx ON payhero_transactions (creator_id);
CREATE INDEX IF NOT EXISTS payhero_transactions_status_pending_idx ON payhero_transactions (status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS subscriptions_period_end_idx ON subscriptions (current_period_end) WHERE status = 'active';

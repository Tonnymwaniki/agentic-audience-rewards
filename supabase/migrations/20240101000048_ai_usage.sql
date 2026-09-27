-- Per-creator AI spend ledger, so "unlimited on Pro" and the Free limits can be
-- backed by real token cost rather than a proxy (video count) that varies wildly
-- with how many comments a video actually has. One row per Anthropic call this
-- app makes on a creator's behalf; lib/ai-usage.ts computes cost_usd from the
-- call's actual usage object at today's Haiku 4.5 pricing.
--
-- RLS enabled with NO client policy, matching every other billing/internals
-- table (subscriptions, payhero_transactions, youtube_oauth_tokens) — a browser
-- has no business reading this directly, only through the service-role checks
-- in lib/ai-usage.ts / lib/entitlements.ts.
create table if not exists ai_usage_events (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references creators(id) on delete cascade,
  -- What kind of call this was, for later cost-breakdown queries ("where is the
  -- spend actually going") without having to reverse-engineer it from token counts.
  feature text not null check (feature in (
    'categorize', 'business_relevance', 'draft_reply',
    'reward_decide', 'reward_critique', 'audience_profile',
    'research_chat'
  )),
  model text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  -- Present for completeness (lib/ai-usage.ts prices these correctly if prompt
  -- caching is ever enabled on a call site) — both are 0 today since no call site
  -- sets cache_control yet (see lib/ai-usage.ts's note on why: Haiku 4.5's 4,096
  -- token cache minimum is bigger than any single prompt in this codebase).
  cache_creation_input_tokens integer not null default 0,
  cache_read_input_tokens integer not null default 0,
  cost_usd numeric(10, 6) not null default 0,
  post_id uuid references posts(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table ai_usage_events enable row level security;

-- Sums this month's spend for a creator (lib/ai-usage.ts's getMonthlyCostUsd).
create index if not exists ai_usage_events_creator_month_idx
  on ai_usage_events (creator_id, created_at);

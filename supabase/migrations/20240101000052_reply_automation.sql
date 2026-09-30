-- Lets a Pro creator turn on unattended reply-sending: instead of approving each
-- draft by hand, a background job (app/api/cron/auto-reply) sends the ones that
-- clear the creator's own rules, so replies keep going out while they're away.
--
-- Off by default for every existing and new creator — this is an opt-in escalation
-- of trust (a reply posted with nobody reviewing it first), never a default.
--
-- Complaints are deliberately NOT a configurable category here: the automation job
-- hard-codes an exclusion for the 'complaint' category regardless of what a creator
-- puts in reply_automation_categories, because a wrong automated reply to an upset
-- commenter is the single costliest mistake this feature could make. There is no
-- setting that overrides that — see app/api/cron/auto-reply/route.ts.
ALTER TABLE creators
  ADD COLUMN IF NOT EXISTS reply_automation_enabled boolean NOT NULL DEFAULT false,
  -- Which categories are eligible for auto-send. 'complaint' is excluded in code even
  -- if present here — kept out of the CHECK constraint's category list on purpose, so
  -- a stray 'complaint' in this array is merely inert rather than a constraint error.
  ADD COLUMN IF NOT EXISTS reply_automation_categories text[] NOT NULL DEFAULT ARRAY['question', 'purchase_intent'],
  -- Minimum draft_confidence to auto-send (comment_categories.draft_confidence is
  -- 'high' | 'medium' | 'low' | null — see lib/confidence.ts). A null-confidence
  -- draft never auto-sends, at any threshold: the job requires a real match, not an
  -- absence of data to read as "good enough".
  ADD COLUMN IF NOT EXISTS reply_automation_min_confidence text NOT NULL DEFAULT 'high'
    CHECK (reply_automation_min_confidence IN ('high', 'medium', 'low')),
  -- Safety brake: at most this many replies auto-send in one cron run, per creator.
  -- Anything past the cap is left for the next run (or manual approval) rather than
  -- sent — protects against a bad batch or a bug matching far more comments than
  -- anyone intended in a single pass.
  ADD COLUMN IF NOT EXISTS reply_automation_max_per_run int NOT NULL DEFAULT 20
    CHECK (reply_automation_max_per_run > 0 AND reply_automation_max_per_run <= 200);

COMMENT ON COLUMN creators.reply_automation_enabled IS
  'Pro-only. When true, the auto-reply cron sends drafts matching this creator''s category/confidence rules without manual approval. Off = fully manual (default and the only behavior before this migration).';

-- Distinguishes a reply the creator personally clicked Approve on from one the
-- automation job sent — the Notifications page audit view reads this to show
-- "Sent automatically" instead of implying a human reviewed it.
ALTER TABLE comment_categories
  ADD COLUMN IF NOT EXISTS reply_auto_sent boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN comment_categories.reply_auto_sent IS
  'True when draft_reply_approved_at was set by the auto-reply cron rather than a manual approve click. Never true unless reply_send_status = sent.';

-- Backs "how many auto-sends has this creator had recently" without a full table
-- scan — the auto-reply job's own rate-limiting query, and the Notifications page
-- audit list.
CREATE INDEX IF NOT EXISTS idx_comment_categories_auto_sent
  ON comment_categories (reply_auto_sent, draft_reply_approved_at)
  WHERE reply_auto_sent = true;

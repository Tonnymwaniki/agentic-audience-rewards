-- Migration 39: draft_reply_created_at means "when a draft was written" — only.
--
-- Migration 7 added the column with DEFAULT now(). That stamped a draft-creation
-- time on EVERY comment_categories row at insert, drafted or not, and (because
-- ADD COLUMN ... DEFAULT fills existing rows) on every row that already existed.
-- On 2026-09-26, 1,431 of 1,518 rows carried a timestamp with no draft, so any
-- "replies drafted" count built on the timestamp counted categorizations instead.
--
-- The application now writes the column only alongside a real draft and clears it
-- when a draft is cleared (lib/categorize.ts, lib/draft-regeneration.ts); this
-- removes the default so no other writer can reintroduce the problem.

ALTER TABLE comment_categories ALTER COLUMN draft_reply_created_at DROP DEFAULT;

-- Idempotent clean-up: a timestamp without a draft is meaningless.
UPDATE comment_categories
SET draft_reply_created_at = NULL
WHERE draft_reply IS NULL
  AND draft_reply_created_at IS NOT NULL;

-- Makes an undrafted "question" (or purchase_intent/complaint) comment tell you WHY
-- it has no draft, instead of looking identical to a comment the agent simply missed.
-- Before this, four different skip paths in lib/categorize.ts and
-- lib/draft-regeneration.ts fell through to nothing more than a console.warn: an
-- unscreened comment (the model omitted the escalation key), a relevance check that
-- itself failed (network/timeout, not a genuine "this is casual" judgment), and a
-- draft-generation call that errored out after retries. All three used to be
-- invisible in the product — same empty state as a comment correctly judged
-- off-topic, or a channel that legitimately isn't verified yet.
ALTER TABLE comment_categories
  ADD COLUMN IF NOT EXISTS draft_skip_reason text
    CHECK (draft_skip_reason IN (
      -- The model's response omitted the escalation key for this comment, so we
      -- don't actually know it's safe to auto-reply to. Distinct from a real
      -- escalation_flag (which already has its own, more specific UI): this is
      -- "we couldn't tell", not "we could tell and it's serious".
      'unscreened',
      -- Genuinely judged casual/off-topic by the relevance check (upload schedule,
      -- chit-chat) — the one INTENTIONAL, working-as-designed skip in this list.
      'not_business_relevant',
      -- The relevance check itself errored or timed out, so "not relevant" was a
      -- fail-closed default, not a real judgment call.
      'relevance_check_failed',
      -- generateDraftReply errored or timed out on every attempt.
      'draft_generation_failed',
      -- Channel ownership isn't verified for this post — already surfaced via
      -- ChannelVerificationBanner, recorded here too so a single query can explain
      -- every undrafted comment without cross-referencing verification state.
      'unverified_channel'
    ));

COMMENT ON COLUMN comment_categories.draft_skip_reason IS
  'Why a draftable comment (question/purchase_intent/complaint) has no draft_reply. NULL means either a draft exists, or the comment was never draftable (praise/spam/other/content_request), or it was escalated (see escalation_flag instead).';

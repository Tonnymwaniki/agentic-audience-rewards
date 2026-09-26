-- Migration 42: creator-controlled entity aliases.
--
-- Entity extraction (migration 41) deliberately does NOT merge a company with its
-- product, or a business with its longer trading name — "Snap"/"Snapchat" may be one
-- thing to one creator and two to another, and a blanket rule would wrongly merge
-- genuinely distinct pairs. This table lets a creator opt in, for THEIR data only:
-- every alias_name is counted as canonical_name wherever entities are aggregated or
-- filtered (lib/entities.ts). Rows are only ever written by the creator (a settings
-- UI, later); nothing populates it automatically.
--
-- Matching is by the same canonical key as entities themselves (case, punctuation
-- and trailing suffixes ignored), so "snapchat" and "Snapchat" are one alias.

CREATE TABLE IF NOT EXISTS entity_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- CASCADE: deleting a creator removes their aliases with them.
  creator_id uuid NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  alias_name text NOT NULL CHECK (length(btrim(alias_name)) > 0),
  canonical_name text NOT NULL CHECK (length(btrim(canonical_name)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (lower(btrim(alias_name)) <> lower(btrim(canonical_name))),
  UNIQUE (creator_id, alias_name)
);

CREATE INDEX IF NOT EXISTS entity_aliases_creator_idx ON entity_aliases (creator_id);

-- Owner-only, for a future settings UI that may use the signed-in session. The app's
-- own reads use the service client with a session-derived creator id.
ALTER TABLE entity_aliases ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS entity_aliases_owner ON entity_aliases;
CREATE POLICY entity_aliases_owner ON entity_aliases
  FOR ALL
  USING (creator_id IN (SELECT id FROM creators WHERE user_id = auth.uid()))
  WITH CHECK (creator_id IN (SELECT id FROM creators WHERE user_id = auth.uid()));

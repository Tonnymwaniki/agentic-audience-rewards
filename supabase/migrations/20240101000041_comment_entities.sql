-- Migration 41: named entities (brands, companies, products, organizations) per
-- comment, extracted during categorization with canonical names (lib/entities.ts).
--
-- NULL = never scanned for entities; '{}' = scanned, none mentioned. Keeping the two
-- apart lets Research say how much of the channel has been scanned instead of
-- presenting partial counts as complete.
--
-- Aggregation ("Safaricom mentioned 47 times") is done in application code
-- (aggregateEntities), which also folds residual spelling variants together. No SQL
-- view on purpose: a view is served through the API with its owner's privileges,
-- which would bypass row-level security and expose every creator's counts.

ALTER TABLE comment_categories ADD COLUMN IF NOT EXISTS entities text[];

-- For "comments mentioning X" lookups (entities @> ARRAY['X']).
CREATE INDEX IF NOT EXISTS comment_categories_entities_idx
  ON comment_categories USING GIN (entities);

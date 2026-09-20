-- Migration: close public write access to the platforms lookup table.
--
-- WHY THIS IS NEEDED
--
-- platforms is the only table in the schema with RLS switched OFF, so access is
-- governed purely by table GRANTs — and those turn out to be wide open. Verified
-- against the live database with nothing but the anon key, the same key that
-- ships inside the browser bundle:
--
--   anon SELECT platforms -> 3 rows  [{"id":1,"name":"youtube"}, …]
--   anon INSERT platforms -> ALLOWED (1 row)      <-- anyone can write to it
--
-- (the probe row was deleted immediately). Reading this table is harmless — it
-- holds three platform names and nothing private — but writing to it is not:
-- ingestion resolves the YouTube platform id through it
-- (lib/ingest.ts: .from('platforms').select('id').eq('name','youtube').single()),
-- and that call uses .single(), so an injected duplicate 'youtube' row turns a
-- successful lookup into an error and breaks ingestion for every creator.
--
-- Migration 18 already intended exactly this change; it is one of the sections
-- of that file that never took effect on this database.
--
-- Reads are deliberately left wide (USING true, granted to anon as well as
-- authenticated) so this is a pure removal of write access and changes no
-- existing read path. Every legitimate read already goes through the
-- service-role key, which bypasses RLS regardless.
--
-- Safe to re-run: DROP IF EXISTS makes the policy idempotent, and enabling RLS
-- on a table that already has it is a no-op.

ALTER TABLE platforms ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS platforms_read_all ON platforms;

CREATE POLICY platforms_read_all ON platforms
  FOR SELECT TO anon, authenticated
  USING (true);

-- Deliberately NO insert/update/delete policy. With RLS enabled and no policy
-- for those commands, anon and authenticated are denied them outright, while the
-- service role continues to bypass RLS entirely.

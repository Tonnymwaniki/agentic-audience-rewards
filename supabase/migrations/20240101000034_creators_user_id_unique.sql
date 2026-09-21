-- One creator row per auth user.
--
-- Creator rows are created by a database trigger on auth.users at signup, not by
-- application code, so nothing in the app was enforcing this. A second row for the
-- same user_id is not merely untidy — it locks the account out completely:
-- lib/api-auth.ts looks the creator up with .maybeSingle(), which errors when more
-- than one row matches, so requireCreator() finds no creator and every
-- authenticated API route returns 403. The same .maybeSingle() lookup appears in
-- the Agent Home, Me and Connect page loads, so the dashboard degrades with it.
--
-- Verified against the live table before writing this: 3 creator rows, 3 distinct
-- user_id values, no NULLs and no rows whose auth user is missing — so the
-- constraint applies without any data repair first.
--
-- NULL user_id is still permitted (Postgres treats NULLs as distinct in a UNIQUE
-- constraint). There are none today, and forbidding them is a separate decision
-- from preventing duplicates.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'creators_user_id_unique'
  ) THEN
    ALTER TABLE creators ADD CONSTRAINT creators_user_id_unique UNIQUE (user_id);
  END IF;
END $$;

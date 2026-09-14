-- Read-only. Changes nothing.
--
-- One query on purpose: the Supabase SQL Editor shows only the last result set
-- when several statements are run together, so the two halves are LEFT JOINed
-- instead. A table with RLS enabled and no policies still appears, as one row
-- with a null policy_name — that is the case we most need to see.

SELECT
  c.relname                        AS table_name,
  c.relrowsecurity                 AS rls_enabled,
  p.polname                        AS policy_name,
  CASE p.polcmd
    WHEN 'r' THEN 'SELECT'
    WHEN 'a' THEN 'INSERT'
    WHEN 'w' THEN 'UPDATE'
    WHEN 'd' THEN 'DELETE'
    WHEN '*' THEN 'ALL'
  END                              AS command,
  CASE WHEN p.polpermissive THEN 'permissive' ELSE 'restrictive' END AS kind,
  COALESCE(
    (SELECT string_agg(r.rolname, ', ' ORDER BY r.rolname)
     FROM pg_roles r WHERE r.oid = ANY (p.polroles)),
    'PUBLIC'
  )                                AS roles,
  pg_get_expr(p.polqual,      c.oid) AS using_expression,
  pg_get_expr(p.polwithcheck, c.oid) AS with_check_expression
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_policy p ON p.polrelid = c.oid
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
ORDER BY c.relname, p.polname NULLS FIRST;

-- Read-only usage report for a hosted InboxLink database. Safe to run any time:
--   psql "$DATABASE_URL" -f scripts/usage-report.sql
-- Counts only; never selects emails, message text or tokens.

\echo '== Per host app (tenant): connected mailboxes and sync activity =='
SELECT
  t.id                                                     AS tenant,
  COUNT(DISTINCT g.id) FILTER (WHERE g.status = 'active')  AS active_grants,
  COUNT(DISTINCT g.id)                                     AS total_grants,
  COUNT(DISTINCT g.external_user_id)                       AS distinct_users,
  MIN(g.created_at)::date                                  AS first_grant,
  MAX(g.created_at)::date                                  AS latest_grant,
  (SELECT COUNT(*) FROM sync_jobs j WHERE j.tenant_id = t.id
     AND j.created_at > NOW() - INTERVAL '7 days')         AS syncs_7d,
  (SELECT MAX(j.created_at) FROM sync_jobs j WHERE j.tenant_id = t.id) AS last_sync
FROM tenants t
LEFT JOIN grants g ON g.tenant_id = t.id
GROUP BY t.id
ORDER BY syncs_7d DESC, total_grants DESC;

\echo '== Syncs per day, last 30 days (all tenants) =='
SELECT created_at::date AS day, tenant_id, COUNT(*) AS syncs,
       COUNT(*) FILTER (WHERE status = 'failed') AS failed
FROM sync_jobs
WHERE created_at > NOW() - INTERVAL '30 days'
GROUP BY 1, 2
ORDER BY 1 DESC, 3 DESC;

\echo '== New grants per week, last 12 weeks =='
SELECT date_trunc('week', created_at)::date AS week, tenant_id, COUNT(*) AS new_grants
FROM grants
WHERE created_at > NOW() - INTERVAL '12 weeks'
GROUP BY 1, 2
ORDER BY 1 DESC;

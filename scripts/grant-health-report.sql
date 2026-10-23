-- Read-only report: live and retired grants by status and age, per host app (tenant).
--   psql "$DATABASE_URL" -f scripts/grant-health-report.sql
-- Counts only; never selects an email address, a grant id, a host user id, a
-- message or a token. Run it before and after a change to grant handling.
-- Age is from created_at. "last sync" is the end of the grant's last finished
-- (completed) sync job; a grant that never finished one counts as "never".

\echo '== Grants by status and age =='
SELECT
  tenant_id                                                   AS tenant,
  status,
  COUNT(*)                                                    AS grants,
  COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')                                         AS under_7_days,
  COUNT(*) FILTER (WHERE created_at <  NOW() - INTERVAL '7 days'  AND created_at >= NOW() - INTERVAL '30 days') AS days_7_to_30,
  COUNT(*) FILTER (WHERE created_at <  NOW() - INTERVAL '30 days' AND created_at >= NOW() - INTERVAL '90 days') AS days_30_to_90,
  COUNT(*) FILTER (WHERE created_at <  NOW() - INTERVAL '90 days')                                        AS over_90_days,
  COUNT(*) FILTER (WHERE replaced_by IS NOT NULL)             AS replaced
FROM grants
GROUP BY tenant_id, status
ORDER BY tenant_id, status;

\echo '== Live grants by kind of host user and last finished sync =='
SELECT
  g.tenant_id                                                 AS tenant,
  CASE
    WHEN g.external_user_id LIKE 'anon\_%'  THEN 'anonymous'
    WHEN g.external_user_id LIKE 'google:%' THEN 'google'
    ELSE 'account'
  END                                                         AS identity_kind,
  g.status,
  COUNT(*)                                                    AS grants,
  COUNT(*) FILTER (WHERE s.last_sync >= NOW() - INTERVAL '7 days')                                    AS synced_7_days,
  COUNT(*) FILTER (WHERE s.last_sync <  NOW() - INTERVAL '7 days' AND s.last_sync >= NOW() - INTERVAL '30 days') AS synced_7_to_30_days,
  COUNT(*) FILTER (WHERE s.last_sync <  NOW() - INTERVAL '30 days')                                   AS synced_over_30_days,
  COUNT(*) FILTER (WHERE s.last_sync IS NULL)                                                         AS never
FROM grants g
LEFT JOIN (
  SELECT grant_id, MAX(finished_at) AS last_sync
  FROM sync_jobs
  WHERE status = 'completed'
  GROUP BY grant_id
) s ON s.grant_id = g.id
WHERE g.status IN ('active', 'needs_reauth')
GROUP BY g.tenant_id, identity_kind, g.status
ORDER BY g.tenant_id, identity_kind, g.status;

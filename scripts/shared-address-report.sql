-- Read-only report: mailboxes connected more than once in the same host app (tenant).
--   psql "$DATABASE_URL" -f scripts/shared-address-report.sql
-- Counts and grant ids only; never selects an email address, message or token.
-- An address is the same when tenant, provider and lower(email) match.
-- "live" means active or needs_reauth (it still holds a token or claims to).

\echo '== Per tenant: addresses with more than one grant =='
SELECT
  tenant_id                                       AS tenant,
  COUNT(*)                                        AS shared_addresses,
  COUNT(*) FILTER (WHERE live > 1)                AS addresses_with_several_live_grants,
  SUM(grants)::int                                AS grants_on_shared_addresses,
  SUM(live)::int                                  AS live_grants_on_shared_addresses
FROM (
  SELECT tenant_id, provider, lower(email) AS address,
         COUNT(*) AS grants,
         COUNT(*) FILTER (WHERE status IN ('active', 'needs_reauth')) AS live
  FROM grants
  GROUP BY tenant_id, provider, lower(email)
  HAVING COUNT(*) > 1
) shared
GROUP BY tenant_id
ORDER BY addresses_with_several_live_grants DESC, shared_addresses DESC;

\echo '== Grants on addresses with several live grants (newest kept on next connect) =='
SELECT
  g.tenant_id                                     AS tenant,
  left(md5(g.tenant_id || '/' || g.provider || '/' || lower(g.email)), 8) AS address_key,
  g.id                                            AS grant_id,
  CASE
    WHEN g.external_user_id LIKE 'anon\_%'  THEN 'anonymous'
    WHEN g.external_user_id LIKE 'google:%' THEN 'google'
    ELSE 'account'
  END                                             AS identity_kind,
  g.status,
  g.created_at::date                              AS created,
  (SELECT COUNT(*) FROM messages m WHERE m.grant_id = g.id) AS cached_messages
FROM grants g
JOIN (
  SELECT tenant_id, provider, lower(email) AS address
  FROM grants
  WHERE status IN ('active', 'needs_reauth')
  GROUP BY tenant_id, provider, lower(email)
  HAVING COUNT(*) > 1
) dup ON dup.tenant_id = g.tenant_id AND dup.provider = g.provider AND dup.address = lower(g.email)
WHERE g.status IN ('active', 'needs_reauth')
ORDER BY tenant, address_key, g.created_at;

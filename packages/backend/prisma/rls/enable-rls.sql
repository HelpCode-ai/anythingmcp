-- =============================================================================
-- Row-Level Security — ENABLE
-- =============================================================================
-- Defense-in-depth tenant isolation on top of the app-layer `where:
-- { organizationId }`. Enables + FORCEs RLS on every org-scoped table and adds
-- an `org_isolation` policy keyed on the transaction-local setting
-- `app.current_org`, which the application sets via PrismaService.tenantTx().
--
-- ⚠️ PREREQUISITE — do NOT run this blindly in production.
-- The app must route org-scoped queries through `tenantTx(orgId, ...)` so every
-- statement sees `current_setting('app.current_org')`. Any query path that does
-- NOT set the context (login-by-email before the org is known, admin/cron paths
-- that span orgs, etc.) will see zero rows or fail its WITH CHECK once this is
-- applied. Enable it only behind ENABLE_RLS, after the call sites are migrated,
-- and give maintenance/cross-org jobs a BYPASSRLS role.
--
-- Idempotent: safe to re-run. Reverse with disable-rls.sql.
-- =============================================================================

DO $$
DECLARE
  t text;
  org_tables text[] := ARRAY[
    'connectors', 'invitation_tokens', 'kg_connector_state', 'kg_edges',
    'kg_nodes', 'kg_skill_suggestions', 'kg_value_seen', 'licenses',
    'mcp_api_keys', 'mcp_server_configs', 'org_settings',
    'organization_members', 'roles', 'tool_invocations', 'user_connector_credentials',
    'users'
  ];
BEGIN
  FOREACH t IN ARRAY org_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS org_isolation ON %I', t);
    -- Fail-closed: with no app.current_org set, current_setting(...,true) is
    -- NULL, so `organization_id = NULL` matches no rows (read) and blocks writes.
    EXECUTE format(
      'CREATE POLICY org_isolation ON %I '
      'USING (organization_id = current_setting(''app.current_org'', true)) '
      'WITH CHECK (organization_id = current_setting(''app.current_org'', true))',
      t
    );
  END LOOP;
END $$;

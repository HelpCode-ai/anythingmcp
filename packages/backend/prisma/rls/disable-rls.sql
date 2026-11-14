-- =============================================================================
-- Row-Level Security — DISABLE (rollback of enable-rls.sql)
-- =============================================================================
-- Drops the org_isolation policy and turns RLS off on every org-scoped table.
-- Idempotent: safe to re-run.
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
    EXECUTE format('DROP POLICY IF EXISTS org_isolation ON %I', t);
    EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

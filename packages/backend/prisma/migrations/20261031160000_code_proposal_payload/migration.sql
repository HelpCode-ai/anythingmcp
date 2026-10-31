-- =============================================================================
-- Migration: code proposal payload
-- =============================================================================
-- Additive and off by default, so this is a no-op for existing installs:
--
--   * kg_skill_suggestions.payload — for a `kind = 'code'` suggestion, the
--     candidate code tool an admin approves into an McpTool
--     (endpointMapping.method = 'code'). Null for a `skill` suggestion and for
--     every existing row. The proposal is inert until an admin approves it
--     through the normal tool-creation path, so an agent-proposed tool can
--     never raise its own authority.
--
-- The ADD COLUMN is nullable with no default, a metadata-only change in
-- Postgres (no table rewrite).
-- =============================================================================

-- AlterTable
ALTER TABLE "kg_skill_suggestions" ADD COLUMN     "payload" JSONB;

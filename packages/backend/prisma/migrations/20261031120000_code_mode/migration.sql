-- =============================================================================
-- Migration: code mode
-- =============================================================================
-- Schema for AnythingMCP code mode (executing short programs that orchestrate
-- several MCP tool calls in one round trip). All additive and off by default,
-- so this is a no-op for existing installs:
--
--   * roles.capabilities           — per-role capability flags (e.g.
--                                     { "inlineCode": true }); null = none.
--   * mcp_server_configs.code_mode — 'off' (default) | 'tools' | 'inline';
--                                     whether a server exposes code tools
--                                     and/or the inline code_execute tool.
--   * kg_skill_suggestions.kind    — 'skill' (default) | 'code'; lets an
--                                     agent-proposed code tool reuse the skill
--                                     approval flow.
--   * code_runs                    — one row per code run (saved tool or
--                                     inline), for per-plan retention and
--                                     quotas. The individual tool calls a run
--                                     makes stay in tool_invocations.
--
-- The three ADD COLUMNs use constant defaults, which Postgres applies as a
-- metadata-only change (no table rewrite). Org-scoped like every audit table;
-- rows go away with the organization, and detach (SET NULL) from a deleted
-- user, server or tool.
-- =============================================================================

-- AlterTable
ALTER TABLE "roles" ADD COLUMN     "capabilities" JSONB;

-- AlterTable
ALTER TABLE "mcp_server_configs" ADD COLUMN     "code_mode" TEXT NOT NULL DEFAULT 'off';

-- AlterTable
ALTER TABLE "kg_skill_suggestions" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'skill';

-- CreateTable
CREATE TABLE "code_runs" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "user_id" TEXT,
    "mcp_server_id" TEXT,
    "tool_id" TEXT,
    "source" TEXT NOT NULL DEFAULT 'tool',
    "status" "InvocationStatus" NOT NULL,
    "duration_ms" INTEGER,
    "tool_call_count" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "code_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "code_runs_organization_id_created_at_idx" ON "code_runs"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "code_runs_user_id_created_at_idx" ON "code_runs"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "code_runs_tool_id_created_at_idx" ON "code_runs"("tool_id", "created_at");

-- AddForeignKey
ALTER TABLE "code_runs" ADD CONSTRAINT "code_runs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "code_runs" ADD CONSTRAINT "code_runs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "code_runs" ADD CONSTRAINT "code_runs_mcp_server_id_fkey" FOREIGN KEY ("mcp_server_id") REFERENCES "mcp_server_configs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "code_runs" ADD CONSTRAINT "code_runs_tool_id_fkey" FOREIGN KEY ("tool_id") REFERENCES "mcp_tools"("id") ON DELETE SET NULL ON UPDATE CASCADE;

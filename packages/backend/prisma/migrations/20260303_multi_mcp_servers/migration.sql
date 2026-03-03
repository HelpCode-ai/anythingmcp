-- AlterTable: Add mcpServerId to API keys
ALTER TABLE "mcp_api_keys" ADD COLUMN "mcp_server_id" TEXT;

-- AlterTable: Evolve McpServerConfig (remove unused fields, add slug/description)
ALTER TABLE "mcp_server_configs" DROP COLUMN IF EXISTS "auth_config",
DROP COLUMN IF EXISTS "auth_type",
DROP COLUMN IF EXISTS "endpoint",
DROP COLUMN IF EXISTS "transport",
ADD COLUMN "description" TEXT,
ADD COLUMN "slug" TEXT NOT NULL DEFAULT 'default',
ALTER COLUMN "name" SET DEFAULT 'Default';

-- CreateTable: MCP Server ↔ Connector pivot
CREATE TABLE "mcp_server_connectors" (
    "id" TEXT NOT NULL,
    "mcp_server_id" TEXT NOT NULL,
    "connector_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mcp_server_connectors_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mcp_server_connectors_mcp_server_id_connector_id_key" ON "mcp_server_connectors"("mcp_server_id", "connector_id");

-- ── Data Migration ──────────────────────────────────────────────────────────
-- For each user who has no MCP server yet, create a default one
INSERT INTO "mcp_server_configs" ("id", "user_id", "name", "slug", "is_active", "created_at", "updated_at")
SELECT
  gen_random_uuid()::text,
  u."id",
  'Default',
  'default',
  true,
  NOW(),
  NOW()
FROM "users" u
WHERE NOT EXISTS (
  SELECT 1 FROM "mcp_server_configs" s WHERE s."user_id" = u."id"
);

-- Assign all connectors to their owner's default MCP server
INSERT INTO "mcp_server_connectors" ("id", "mcp_server_id", "connector_id", "created_at")
SELECT
  gen_random_uuid()::text,
  s."id",
  c."id",
  NOW()
FROM "connectors" c
JOIN "mcp_server_configs" s ON s."user_id" = c."user_id" AND s."slug" = 'default';

-- Link existing API keys to their owner's default MCP server
UPDATE "mcp_api_keys" k
SET "mcp_server_id" = s."id"
FROM "mcp_server_configs" s
WHERE s."user_id" = k."user_id" AND s."slug" = 'default';

-- ── End Data Migration ──────────────────────────────────────────────────────

-- CreateIndex: unique constraint on (userId, slug)
CREATE UNIQUE INDEX "mcp_server_configs_user_id_slug_key" ON "mcp_server_configs"("user_id", "slug");

-- AddForeignKey
ALTER TABLE "mcp_api_keys" ADD CONSTRAINT "mcp_api_keys_mcp_server_id_fkey" FOREIGN KEY ("mcp_server_id") REFERENCES "mcp_server_configs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_server_connectors" ADD CONSTRAINT "mcp_server_connectors_mcp_server_id_fkey" FOREIGN KEY ("mcp_server_id") REFERENCES "mcp_server_configs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_server_connectors" ADD CONSTRAINT "mcp_server_connectors_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

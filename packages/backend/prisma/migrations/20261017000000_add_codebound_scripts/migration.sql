-- A script's server must belong to its organization, including direct DB writes.
CREATE UNIQUE INDEX "mcp_server_configs_id_organization_id_key"
    ON "mcp_server_configs"("id", "organization_id");

CREATE TABLE "codebound_scripts" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "mcp_server_id" TEXT NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "code" TEXT NOT NULL,
    "input" JSONB NOT NULL DEFAULT '{}',
    "allowed_tools" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "codebound_scripts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "codebound_scripts_organization_id_updated_at_id_idx"
    ON "codebound_scripts"("organization_id", "updated_at", "id");
CREATE INDEX "codebound_scripts_mcp_server_id_organization_id_idx"
    ON "codebound_scripts"("mcp_server_id", "organization_id");

ALTER TABLE "codebound_scripts" ADD CONSTRAINT "codebound_scripts_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "codebound_scripts" ADD CONSTRAINT "codebound_scripts_mcp_server_id_organization_id_fkey"
    FOREIGN KEY ("mcp_server_id", "organization_id")
    REFERENCES "mcp_server_configs"("id", "organization_id")
    ON DELETE CASCADE ON UPDATE CASCADE;

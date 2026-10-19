-- Workspace skills v2: long procedures served on demand, versions, usage,
-- and a per-server choice of how skills reach the model on initialize.
ALTER TABLE "kg_skill_suggestions" ADD COLUMN "body" TEXT;
ALTER TABLE "kg_skill_suggestions" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "kg_skill_suggestions" ADD COLUMN "use_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "kg_skill_suggestions" ADD COLUMN "last_used_at" TIMESTAMP(3);

ALTER TABLE "mcp_server_configs" ADD COLUMN "skills_delivery" TEXT NOT NULL DEFAULT 'auto';

CREATE TABLE "kg_skill_versions" (
    "id" TEXT NOT NULL,
    "skill_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "when_to_use" TEXT NOT NULL,
    "instruction" TEXT NOT NULL,
    "body" TEXT,
    "edited_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kg_skill_versions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "kg_skill_versions_skill_id_version_key" ON "kg_skill_versions"("skill_id", "version");
CREATE INDEX "kg_skill_versions_organization_id_idx" ON "kg_skill_versions"("organization_id");

ALTER TABLE "kg_skill_versions" ADD CONSTRAINT "kg_skill_versions_skill_id_fkey" FOREIGN KEY ("skill_id") REFERENCES "kg_skill_suggestions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- `auto` switches to an index above 6,000 characters of applied skills. Keep
-- today's behaviour (full text) on servers already above it, so nothing
-- changes until an admin picks a mode. Counts the server's own skills; the
-- 6000 must match SKILLS_INLINE_BUDGET in kg-skill.service.ts.
UPDATE "mcp_server_configs" AS s
SET "skills_delivery" = 'inline'
WHERE s."id" IN (
    SELECT k."mcp_server_id"
    FROM "kg_skill_suggestions" AS k
    WHERE k."status" = 'applied' AND k."mcp_server_id" IS NOT NULL
    GROUP BY k."mcp_server_id"
    HAVING SUM(length(k."title") + length(k."when_to_use") + length(k."instruction")) > 6000
);

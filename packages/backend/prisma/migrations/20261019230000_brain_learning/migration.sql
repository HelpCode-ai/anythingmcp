-- Whether a call's caller contributed to skill learning when it was made.
-- A constant default on a new column is a catalog-only change in Postgres:
-- no rewrite of tool_invocations. Existing calls are not learnable.
ALTER TABLE "tool_invocations" ADD COLUMN "learnable" BOOLEAN NOT NULL DEFAULT false;

-- Consolidation proposals record the applied skills they replace.
ALTER TABLE "kg_skill_suggestions" ADD COLUMN "replaces" JSONB NOT NULL DEFAULT '[]';

-- Memory items can be about a knowledge-graph entity.
ALTER TABLE "memory_items" ADD COLUMN "about" TEXT;
CREATE INDEX "memory_items_organization_id_about_idx" ON "memory_items"("organization_id", "about");

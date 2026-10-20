-- Workspace memory: facts, preferences and notes AI clients save and find
-- again, per member (personal) or for the whole organization.
CREATE TABLE "memory_items" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "owner_user_id" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'fact',
    "content" TEXT NOT NULL,
    "tags" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'active',
    "source" JSONB NOT NULL DEFAULT '{}',
    "created_by_user_id" TEXT,
    "approved_by_user_id" TEXT,
    "approved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    -- Full-text search without a new dependency. The 'simple' configuration
    -- does not stem, so it treats German, Italian and English alike.
    "search_vector" tsvector GENERATED ALWAYS AS (to_tsvector('simple', "content")) STORED,

    CONSTRAINT "memory_items_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "memory_items_organization_id_scope_status_idx" ON "memory_items"("organization_id", "scope", "status");
CREATE INDEX "memory_items_organization_id_owner_user_id_idx" ON "memory_items"("organization_id", "owner_user_id");
CREATE INDEX "memory_items_search_vector_idx" ON "memory_items" USING GIN ("search_vector");

ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Per-member memory access, set by an admin; `inherit` follows the workspace default.
ALTER TABLE "organization_members" ADD COLUMN "memory_access" TEXT NOT NULL DEFAULT 'inherit';

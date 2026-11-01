-- File Search (#1379, #1380): FILE_SEARCH connectors, their index and File Share links.
-- AlterEnum
ALTER TYPE "ConnectorType" ADD VALUE 'FILE_SEARCH';

-- CreateTable
CREATE TABLE "file_sources" (
    "connector_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "setup_state" TEXT NOT NULL DEFAULT 'draft',
    "paused_reason" TEXT,
    "paused_at" TIMESTAMP(3),
    "pause_notified_at" TIMESTAMP(3),
    "summary" TEXT,
    "instructions_draft" TEXT,
    "sync_interval_minutes" INTEGER NOT NULL DEFAULT 1440,
    "next_sync_at" TIMESTAMP(3),
    "lease_owner" TEXT,
    "lease_until" TIMESTAMP(3),
    "last_run_id" TEXT,
    "last_success_at" TIMESTAMP(3),
    "manual_sync_day" TEXT,
    "manual_sync_count" INTEGER NOT NULL DEFAULT 0,
    "stats" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "file_sources_pkey" PRIMARY KEY ("connector_id")
);

-- CreateTable
CREATE TABLE "file_scans" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "connector_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "progress" JSONB NOT NULL DEFAULT '{}',
    "tree" JSONB,
    "types" JSONB,
    "totals" JSONB,
    "samples" JSONB,
    "suggestions" JSONB,
    "description" JSONB,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "created_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "file_scans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_sync_runs" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "connector_id" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "counters" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,
    "worker_id" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "file_sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_entries" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "connector_id" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ext" TEXT NOT NULL DEFAULT '',
    "dir" TEXT NOT NULL DEFAULT '',
    "size" BIGINT NOT NULL DEFAULT 0,
    "mtime" TIMESTAMP(3),
    "etag" TEXT,
    "sha256" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "page_count" INTEGER,
    "text_chars" INTEGER NOT NULL DEFAULT 0,
    "indexed_at" TIMESTAMP(3),
    "seen_run_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "file_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_chunks" (
    "id" BIGSERIAL NOT NULL,
    "organization_id" TEXT NOT NULL,
    "connector_id" TEXT NOT NULL,
    "entry_id" TEXT NOT NULL,
    "page" INTEGER,
    "ord" INTEGER NOT NULL DEFAULT 0,
    "content" TEXT NOT NULL,
    "search_vector" tsvector GENERATED ALWAYS AS (to_tsvector('simple', "content")) STORED,

    CONSTRAINT "file_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_shares" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "created_by_user_id" TEXT,
    "source" TEXT NOT NULL,
    "connector_id" TEXT,
    "entry_path" TEXT,
    "storage_key" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "access" TEXT NOT NULL DEFAULT 'internal',
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3),
    "max_downloads" INTEGER,
    "download_count" INTEGER NOT NULL DEFAULT 0,
    "revoked_at" TIMESTAMP(3),
    "purged_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "file_shares_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_access_rules" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "connector_id" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "effect" TEXT NOT NULL DEFAULT 'allow',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "file_access_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "file_sources_organization_id_idx" ON "file_sources"("organization_id");

-- CreateIndex
CREATE INDEX "file_sources_setup_state_next_sync_at_idx" ON "file_sources"("setup_state", "next_sync_at");

-- CreateIndex
CREATE INDEX "file_scans_organization_id_idx" ON "file_scans"("organization_id");

-- CreateIndex
CREATE INDEX "file_scans_connector_id_created_at_idx" ON "file_scans"("connector_id", "created_at");

-- CreateIndex
CREATE INDEX "file_scans_status_idx" ON "file_scans"("status");

-- CreateIndex
CREATE INDEX "file_sync_runs_organization_id_idx" ON "file_sync_runs"("organization_id");

-- CreateIndex
CREATE INDEX "file_sync_runs_connector_id_started_at_idx" ON "file_sync_runs"("connector_id", "started_at");

-- CreateIndex
CREATE INDEX "file_entries_organization_id_idx" ON "file_entries"("organization_id");

-- CreateIndex
CREATE INDEX "file_entries_connector_id_status_idx" ON "file_entries"("connector_id", "status");

-- CreateIndex
CREATE INDEX "file_entries_connector_id_dir_idx" ON "file_entries"("connector_id", "dir");

-- CreateIndex
CREATE UNIQUE INDEX "file_entries_connector_id_path_key" ON "file_entries"("connector_id", "path");

-- CreateIndex
CREATE INDEX "file_chunks_entry_id_idx" ON "file_chunks"("entry_id");

-- CreateIndex
CREATE INDEX "file_chunks_connector_id_idx" ON "file_chunks"("connector_id");

-- CreateIndex
CREATE INDEX "file_chunks_organization_id_idx" ON "file_chunks"("organization_id");

-- CreateIndex
CREATE INDEX "file_chunks_search_vector_idx" ON "file_chunks" USING GIN ("search_vector");

-- CreateIndex
CREATE UNIQUE INDEX "file_shares_token_hash_key" ON "file_shares"("token_hash");

-- CreateIndex
CREATE INDEX "file_shares_organization_id_created_at_idx" ON "file_shares"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "file_shares_expires_at_idx" ON "file_shares"("expires_at");

-- CreateIndex
CREATE INDEX "file_access_rules_connector_id_role_id_idx" ON "file_access_rules"("connector_id", "role_id");

-- CreateIndex
CREATE INDEX "file_access_rules_organization_id_idx" ON "file_access_rules"("organization_id");

-- AddForeignKey
ALTER TABLE "file_sources" ADD CONSTRAINT "file_sources_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_sources" ADD CONSTRAINT "file_sources_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_scans" ADD CONSTRAINT "file_scans_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_scans" ADD CONSTRAINT "file_scans_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_sync_runs" ADD CONSTRAINT "file_sync_runs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_sync_runs" ADD CONSTRAINT "file_sync_runs_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_entries" ADD CONSTRAINT "file_entries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_entries" ADD CONSTRAINT "file_entries_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_chunks" ADD CONSTRAINT "file_chunks_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_chunks" ADD CONSTRAINT "file_chunks_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_chunks" ADD CONSTRAINT "file_chunks_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "file_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_shares" ADD CONSTRAINT "file_shares_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_shares" ADD CONSTRAINT "file_shares_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_shares" ADD CONSTRAINT "file_shares_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_access_rules" ADD CONSTRAINT "file_access_rules_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_access_rules" ADD CONSTRAINT "file_access_rules_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_access_rules" ADD CONSTRAINT "file_access_rules_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Trigram search on paths and names (file_find) ─────────────────────────
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX "file_entries_path_trgm_idx" ON "file_entries" USING GIN ("path" gin_trgm_ops);

-- ── Row-level security on every file_* table ──────────────────────────────
-- Queries on these tables run inside PrismaService.tenantTx(orgId) followed by
-- SET LOCAL ROLE amcp_files (see file-search.repository.ts). The role has no
-- login, no BYPASSRLS and rights on file_* only, so the org_isolation policy
-- applies even while the application connects as a superuser. A statement
-- without app.current_org sees no rows and cannot write.
-- Without CREATEROLE (some managed databases) the role is skipped with a
-- notice: the policies below then apply to the application user itself,
-- which is enough as long as it is not a superuser and has no BYPASSRLS. The
-- repository switches to amcp_files only when the role is granted to it.
DO $$
DECLARE
  t text;
  file_tables text[] := ARRAY[
    'file_sources', 'file_scans', 'file_sync_runs', 'file_entries',
    'file_chunks', 'file_shares', 'file_access_rules'
  ];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'amcp_files') THEN
    CREATE ROLE amcp_files NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  EXECUTE format('GRANT amcp_files TO %I', current_user);
  GRANT USAGE ON SCHEMA public TO amcp_files;
  FOREACH t IN ARRAY file_tables LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO amcp_files', t);
  END LOOP;
  GRANT USAGE, SELECT ON SEQUENCE "file_chunks_id_seq" TO amcp_files;
  -- Read-only lookups the file queries join against.
  GRANT SELECT ("id", "organization_id", "type", "is_active", "name") ON "connectors" TO amcp_files;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'amcp_files role not created (%): Row-Level Security applies to the application user directly', SQLERRM;
END $$;

DO $$
DECLARE
  t text;
  file_tables text[] := ARRAY[
    'file_sources', 'file_scans', 'file_sync_runs', 'file_entries',
    'file_chunks', 'file_shares', 'file_access_rules'
  ];
BEGIN
  FOREACH t IN ARRAY file_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS org_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY org_isolation ON %I '
      'USING (organization_id = current_setting(''app.current_org'', true)) '
      'WITH CHECK (organization_id = current_setting(''app.current_org'', true))',
      t
    );
  END LOOP;
END $$;

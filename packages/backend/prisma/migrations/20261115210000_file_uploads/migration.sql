-- Agent file uploads: files an AI client uploads through a one-time link so a
-- connector tool can send them. Additive: a new table nothing else reads.
-- No foreign keys on purpose (see the model comment in schema.prisma).

CREATE TABLE "file_uploads" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "created_by_user_id" TEXT,
    "mcp_server_id" TEXT,
    "filename" TEXT NOT NULL,
    "mime_type" TEXT,
    "max_bytes" INTEGER NOT NULL,
    "bytes" INTEGER,
    "sha256" TEXT,
    "storage_key" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "upload_by" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3),
    "use_count" INTEGER NOT NULL DEFAULT 0,
    "public_downloads" INTEGER NOT NULL DEFAULT 0,
    "purged_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "file_uploads_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "file_uploads_token_hash_key" ON "file_uploads"("token_hash");
CREATE INDEX "file_uploads_organization_id_created_at_idx" ON "file_uploads"("organization_id", "created_at");
CREATE INDEX "file_uploads_state_expires_at_idx" ON "file_uploads"("state", "expires_at");
CREATE INDEX "file_uploads_created_at_idx" ON "file_uploads"("created_at");

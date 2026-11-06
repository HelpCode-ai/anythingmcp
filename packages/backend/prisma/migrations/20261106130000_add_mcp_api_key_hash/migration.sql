-- Phase 1 of hashing per-user API keys at rest. Additive only: the plaintext
-- `key` column stays until every row is hashed (the backend backfills
-- `key_hash` / `key_suffix` at boot), so an older container keeps working.

-- AlterTable
ALTER TABLE "mcp_api_keys" ADD COLUMN     "key_hash" TEXT,
ADD COLUMN     "key_suffix" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "mcp_api_keys_key_hash_key" ON "mcp_api_keys"("key_hash");

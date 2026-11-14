-- Short-lived support keys (phase 2 of hashing API keys at rest). Additive:
-- existing keys get no expiry and are not support keys, so behaviour is
-- unchanged and an older container keeps working.

-- AlterTable
ALTER TABLE "mcp_api_keys" ADD COLUMN     "expires_at" TIMESTAMP(3),
ADD COLUMN     "is_support" BOOLEAN NOT NULL DEFAULT false;

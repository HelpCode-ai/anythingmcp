-- AlterTable
ALTER TABLE "oauth_authorization_codes" ALTER COLUMN "expires_at" SET DATA TYPE BIGINT;

-- AlterTable
ALTER TABLE "oauth_sessions" ALTER COLUMN "expires_at" SET DATA TYPE BIGINT;

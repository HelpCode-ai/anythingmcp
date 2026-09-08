-- DropIndex
DROP INDEX "users_onboarding_drip_idx";

-- AlterTable
ALTER TABLE "identity_providers" ADD COLUMN     "role_sync_default_role_ids" TEXT[] DEFAULT ARRAY[]::TEXT[];

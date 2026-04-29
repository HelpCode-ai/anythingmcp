-- =============================================================================
-- Migration: Make users.organization_id nullable + SetNull on delete
-- =============================================================================
-- Required so that deleting an Organization does not cascade-delete users
-- whose CACHED active org happens to be that org. Org-deletion now explicitly
-- migrates each affected user to their next-oldest membership in a transaction;
-- if no other membership exists, organization_id is left NULL.
-- =============================================================================

-- 1. Drop existing CASCADE foreign key
ALTER TABLE "users" DROP CONSTRAINT "users_organization_id_fkey";

-- 2. Make column nullable
ALTER TABLE "users" ALTER COLUMN "organization_id" DROP NOT NULL;

-- 3. Re-create FK with ON DELETE SET NULL
ALTER TABLE "users" ADD CONSTRAINT "users_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

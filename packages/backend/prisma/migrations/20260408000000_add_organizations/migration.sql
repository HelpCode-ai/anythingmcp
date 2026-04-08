-- =============================================================================
-- Migration: Add Organizations (multi-tenancy)
-- =============================================================================
-- Creates an Organization model and adds organization_id to:
-- users, connectors, mcp_server_configs, roles, mcp_api_keys, invitation_tokens
-- Groups existing users by invitation chains into shared organizations.
-- =============================================================================

-- 1. Create organizations table
CREATE TABLE "organizations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- 2. Add nullable organization_id columns (will be made NOT NULL after data migration)
ALTER TABLE "users" ADD COLUMN "organization_id" TEXT;
ALTER TABLE "connectors" ADD COLUMN "organization_id" TEXT;
ALTER TABLE "mcp_server_configs" ADD COLUMN "organization_id" TEXT;
ALTER TABLE "roles" ADD COLUMN "organization_id" TEXT;
ALTER TABLE "mcp_api_keys" ADD COLUMN "organization_id" TEXT;
ALTER TABLE "invitation_tokens" ADD COLUMN "organization_id" TEXT;

-- 3. Data migration: create organizations and assign users
-- 3a. Build a temp table mapping each user to their "root admin" via invitation chains
CREATE TEMP TABLE user_org_root AS
WITH RECURSIVE invite_chain AS (
    -- Base case: users who were NOT invited (self-registered) → they are their own root
    SELECT u.id AS user_id, u.id AS root_id
    FROM users u
    WHERE NOT EXISTS (
        SELECT 1 FROM invitation_tokens it
        WHERE it.email = u.email AND it.used_at IS NOT NULL
    )

    UNION ALL

    -- Recursive case: follow the invitation chain upward
    SELECT u.id AS user_id, ic.root_id
    FROM users u
    JOIN invitation_tokens it ON it.email = u.email AND it.used_at IS NOT NULL
    JOIN invite_chain ic ON ic.user_id = it.invited_by
)
SELECT DISTINCT ON (user_id) user_id, root_id
FROM invite_chain;

-- 3b. Create one organization per unique root user
INSERT INTO organizations (id, name, created_at, updated_at)
SELECT DISTINCT
    'org_' || root_id,
    COALESCE(u.name, split_part(u.email, '@', 1)) || '''s Workspace',
    NOW(),
    NOW()
FROM user_org_root uor
JOIN users u ON u.id = uor.root_id;

-- 3c. Assign organization_id to users
UPDATE users SET organization_id = 'org_' || uor.root_id
FROM user_org_root uor
WHERE users.id = uor.user_id;

-- 3d. Handle any users not covered by the recursive CTE (edge case)
-- Create personal orgs for them
INSERT INTO organizations (id, name, created_at, updated_at)
SELECT
    'org_' || u.id,
    COALESCE(u.name, split_part(u.email, '@', 1)) || '''s Workspace',
    NOW(),
    NOW()
FROM users u
WHERE u.organization_id IS NULL
ON CONFLICT (id) DO NOTHING;

UPDATE users SET organization_id = 'org_' || id
WHERE organization_id IS NULL;

-- 3e. Set organization_id on connectors from their owner
UPDATE connectors SET organization_id = u.organization_id
FROM users u WHERE connectors.user_id = u.id;

-- 3f. Set organization_id on mcp_server_configs from their owner
UPDATE mcp_server_configs SET organization_id = u.organization_id
FROM users u WHERE mcp_server_configs.user_id = u.id;

-- 3g. Set organization_id on mcp_api_keys from their owner
UPDATE mcp_api_keys SET organization_id = u.organization_id
FROM users u WHERE mcp_api_keys.user_id = u.id;

-- 3h. Set organization_id on roles (non-system roles get the first admin's org)
UPDATE roles SET organization_id = (
    SELECT u.organization_id FROM users u WHERE u.role = 'ADMIN' ORDER BY u.created_at ASC LIMIT 1
)
WHERE is_system = false AND organization_id IS NULL;

-- 3i. Set organization_id on invitation_tokens from the inviter
UPDATE invitation_tokens SET organization_id = u.organization_id
FROM users u WHERE invitation_tokens.invited_by = u.id;

-- Handle orphan invitation tokens (inviter deleted)
UPDATE invitation_tokens SET organization_id = (
    SELECT id FROM organizations ORDER BY created_at ASC LIMIT 1
)
WHERE organization_id IS NULL;

-- Clean up temp table
DROP TABLE IF EXISTS user_org_root;

-- 4. Make columns NOT NULL (except roles.organization_id which stays nullable for system roles)
ALTER TABLE "users" ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "connectors" ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "mcp_server_configs" ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "mcp_api_keys" ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "invitation_tokens" ALTER COLUMN "organization_id" SET NOT NULL;

-- 5. Add foreign key constraints
ALTER TABLE "users" ADD CONSTRAINT "users_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "connectors" ADD CONSTRAINT "connectors_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "mcp_server_configs" ADD CONSTRAINT "mcp_server_configs_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "roles" ADD CONSTRAINT "roles_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "mcp_api_keys" ADD CONSTRAINT "mcp_api_keys_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "invitation_tokens" ADD CONSTRAINT "invitation_tokens_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 6. Add indexes
CREATE INDEX "users_organization_id_idx" ON "users"("organization_id");
CREATE INDEX "connectors_organization_id_idx" ON "connectors"("organization_id");
CREATE INDEX "mcp_server_configs_organization_id_idx" ON "mcp_server_configs"("organization_id");
CREATE INDEX "mcp_api_keys_organization_id_idx" ON "mcp_api_keys"("organization_id");

-- 7. Update unique constraints
-- Role name must be unique per organization (or globally for system roles)
DROP INDEX IF EXISTS "roles_name_key";
CREATE UNIQUE INDEX "roles_organization_id_name_key" ON "roles"("organization_id", "name");

-- MCP server slug must be unique per organization (was per user)
DROP INDEX IF EXISTS "mcp_server_configs_user_id_slug_key";
CREATE UNIQUE INDEX "mcp_server_configs_organization_id_slug_key" ON "mcp_server_configs"("organization_id", "slug");

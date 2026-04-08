-- =============================================================================
-- Migration: Add OrganizationMember, OrgSettings, License.organizationId
-- =============================================================================
-- Adds multi-org membership, per-org settings, and per-org licensing support.
-- =============================================================================

-- 1. Create organization_members table
CREATE TABLE "organization_members" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'EDITOR',
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_members_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "organization_members_user_id_organization_id_key" ON "organization_members"("user_id", "organization_id");
CREATE INDEX "organization_members_user_id_idx" ON "organization_members"("user_id");
CREATE INDEX "organization_members_organization_id_idx" ON "organization_members"("organization_id");

ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 2. Create org_settings table
CREATE TABLE "org_settings" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "org_settings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "org_settings_organization_id_key_key" ON "org_settings"("organization_id", "key");

ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 3. Add organization_id to licenses
ALTER TABLE "licenses" ADD COLUMN "organization_id" TEXT;

ALTER TABLE "licenses" ADD CONSTRAINT "licenses_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "licenses_organization_id_idx" ON "licenses"("organization_id");

-- 4. Backfill organization_members from existing users
INSERT INTO organization_members (id, user_id, organization_id, role, joined_at)
SELECT
    gen_random_uuid()::text,
    id,
    organization_id,
    role,
    created_at
FROM users
WHERE organization_id IS NOT NULL;

-- 5. Assign existing license to the user's org (if license and org exist)
UPDATE licenses SET organization_id = (
    SELECT organization_id FROM users WHERE role = 'ADMIN' ORDER BY created_at ASC LIMIT 1
)
WHERE organization_id IS NULL;

-- 6. Copy smtp_config from site_settings to org_settings for each org
INSERT INTO org_settings (id, organization_id, key, value, updated_at)
SELECT
    gen_random_uuid()::text,
    o.id,
    'smtp_config',
    ss.value,
    ss.updated_at
FROM site_settings ss
CROSS JOIN organizations o
WHERE ss.key = 'smtp_config';

-- 7. Copy footer_links from site_settings to org_settings for each org
INSERT INTO org_settings (id, organization_id, key, value, updated_at)
SELECT
    gen_random_uuid()::text,
    o.id,
    'footer_links',
    ss.value,
    ss.updated_at
FROM site_settings ss
CROSS JOIN organizations o
WHERE ss.key = 'footer_links';

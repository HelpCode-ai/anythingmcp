-- =============================================================================
-- Migration: Identity providers (SSO configuration) + role mappings
-- =============================================================================
-- Per-organization SSO configuration. Generic across provider types from the
-- start: adding Google or Okta later must not require a migration on a table
-- that carries authentication trust anchors. Per-type settings live in the
-- `config` JSONB, validated by a Zod schema keyed on `type` — the same
-- shape-in-Json approach the connector engines already use.
--
-- `organization_id` is the authority on which workspace a session belongs to,
-- so it is never reassigned; the application layer treats it as immutable.
--
-- `client_secret_enc` holds AES-256-GCM ciphertext whose AAD is bound to
-- (provider id, organization id), so a blob cannot be copied into another row
-- and still decrypt. It is never returned by the API.
--
-- `initiate_id` is the opaque entry point for /sso/<id>. Deliberately not a
-- readable slug: that would allow workspace enumeration, squatting on names
-- like `admin`, and homoglyph typosquatting on the very URL a human is asked
-- to trust.
-- =============================================================================

CREATE TYPE "IdentityProviderType" AS ENUM ('ENTRA', 'GOOGLE', 'OKTA', 'AUTH0', 'GITHUB', 'OIDC');
CREATE TYPE "RoleSyncSource"       AS ENUM ('APP_ROLES', 'GROUPS');
CREATE TYPE "RoleSyncFallback"     AS ENUM ('DENY_ALL', 'KEEP_EXISTING', 'DEFAULT_ROLE');

CREATE TABLE "identity_providers" (
    "id"                        TEXT NOT NULL,
    "organization_id"           TEXT NOT NULL,
    "type"                      "IdentityProviderType" NOT NULL,
    "name"                      TEXT NOT NULL,
    "is_active"                 BOOLEAN NOT NULL DEFAULT true,
    "issuer"                    TEXT NOT NULL,
    "client_id"                 TEXT NOT NULL,
    "client_secret_enc"         TEXT,
    "client_secret_expires_at"  TIMESTAMP(3),
    "initiate_id"               TEXT NOT NULL,
    "jit_provisioning"          BOOLEAN NOT NULL DEFAULT false,
    -- Capped at VIEWER in the service layer, never ADMIN or EDITOR.
    "jit_default_role"          "UserRole" NOT NULL DEFAULT 'VIEWER',
    "role_sync_enabled"         BOOLEAN NOT NULL DEFAULT false,
    "role_sync_source"          "RoleSyncSource" NOT NULL DEFAULT 'GROUPS',
    -- DENY_ALL by default: the alternative fails OPEN, because a user with no
    -- role assignment is unrestricted.
    "role_sync_fallback"        "RoleSyncFallback" NOT NULL DEFAULT 'DENY_ALL',
    "enforce_sso"               BOOLEAN NOT NULL DEFAULT false,
    -- Guards `enforce_sso`: it cannot be switched on before a real sign-in has
    -- succeeded, so a misconfiguration cannot lock a whole workspace out.
    "last_successful_login_at"  TIMESTAMP(3),
    "config"                    JSONB NOT NULL DEFAULT '{}',
    "created_at"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"                TIMESTAMP(3) NOT NULL,

    CONSTRAINT "identity_providers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "identity_providers_initiate_id_key"          ON "identity_providers"("initiate_id");
CREATE UNIQUE INDEX "identity_providers_organization_id_name_key" ON "identity_providers"("organization_id", "name");
CREATE INDEX "identity_providers_organization_id_idx"             ON "identity_providers"("organization_id");

ALTER TABLE "identity_providers" ADD CONSTRAINT "identity_providers_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Maps an external group / application role onto AnythingMCP roles.
-- `external_id` is the group OBJECT ID or the app role `value`, never the
-- display name: Microsoft states group names are not unique, so any user able
-- to create a group could otherwise mint one matching a privileged mapping.
CREATE TABLE "identity_provider_role_mappings" (
    "id"           TEXT NOT NULL,
    "provider_id"  TEXT NOT NULL,
    "external_id"  TEXT NOT NULL,
    "label"        TEXT,
    "user_role"    "UserRole",
    "mcp_role_ids" TEXT[] NOT NULL DEFAULT '{}',
    "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "identity_provider_role_mappings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "identity_provider_role_mappings_provider_id_external_id_key"
    ON "identity_provider_role_mappings"("provider_id", "external_id");
CREATE INDEX "identity_provider_role_mappings_provider_id_idx"
    ON "identity_provider_role_mappings"("provider_id");

ALTER TABLE "identity_provider_role_mappings" ADD CONSTRAINT "identity_provider_role_mappings_provider_id_fkey"
    FOREIGN KEY ("provider_id") REFERENCES "identity_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

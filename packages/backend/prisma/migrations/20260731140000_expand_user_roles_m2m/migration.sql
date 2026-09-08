-- =============================================================================
-- Migration: Expand User→Role to a per-organization many-to-many (user_roles)
-- =============================================================================
-- EXPAND phase. `users.mcp_role_id` and `invitation_tokens.mcp_role_id` are
-- KEPT and dropped in a CONTRACT migration a release later. Dropping them now
-- would break a still-running old container on every query against the User
-- model — Prisma emits an explicit column list, never SELECT * — including the
-- login path, and a redeploy would not restore the column.
--
-- Why `users.mcp_role_id` had to go:
--   * single-valued — a user in several IdP groups must accumulate the UNION of
--     those groups' tool whitelists;
--   * GLOBAL — one role across every workspace, so per-org governance was
--     impossible and one org's admin could overwrite another org's assignment.
--
-- NO sync trigger and NO dual-write, unlike the usual expand/contract recipe.
-- Those protect live traffic on existing data during a rolling deploy, and that
-- combination does not occur here: the cloud deploys rolling but holds zero
-- rows (0 tool_role_access, 0 users with mcp_role_id — measured), while
-- self-hosted installs may hold data but recreate the container rather than
-- rolling. The backfill below is what serves those installs.
-- =============================================================================

CREATE TABLE "user_roles" (
    "id"              TEXT NOT NULL,
    "user_id"         TEXT NOT NULL,
    "role_id"         TEXT NOT NULL,
    -- Nullable by design: a null-org grant applies in every organization, which
    -- is how a grant of an `is_system` role behaves. Forcing NOT NULL would
    -- make the backfill drop rows it cannot attribute, and a dropped grant
    -- fails OPEN (no grant at all = unrestricted), so strict would be weaker.
    "organization_id" TEXT,
    -- 'manual' = set by an admin, 'entra' = derived from an IdP group claim.
    "source"          TEXT NOT NULL DEFAULT 'manual',
    "external_ref"    TEXT,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("id")
);

-- `source` is part of the unique key so revoking an IdP-derived grant can never
-- silently delete one an admin created by hand for the same (user, role).
CREATE UNIQUE INDEX "user_roles_user_id_role_id_source_key"
    ON "user_roles"("user_id", "role_id", "source");
CREATE INDEX "user_roles_user_id_idx"         ON "user_roles"("user_id");
CREATE INDEX "user_roles_role_id_idx"         ON "user_roles"("role_id");
CREATE INDEX "user_roles_organization_id_idx" ON "user_roles"("organization_id");

ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_fkey"
    FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Multi-role invitations. The scalar column stays for invites created by the
-- previous release, which remain valid for their 48h lifetime.
ALTER TABLE "invitation_tokens"
    ADD COLUMN "mcp_role_ids" TEXT[] NOT NULL DEFAULT '{}';

-- Backfill. A no-op on the cloud database (zero rows) and the whole point of
-- this migration for self-hosted installs. `organization_id` falls back to the
-- role's own org, and stays NULL when neither is known — which is exactly the
-- "applies everywhere" semantics, so nothing is lost.
INSERT INTO "user_roles" (id, user_id, role_id, organization_id, source, created_at)
SELECT gen_random_uuid()::text,
       u.id,
       u.mcp_role_id,
       COALESCE(u.organization_id, r.organization_id),
       'manual',
       u.updated_at
FROM users u
JOIN roles r ON r.id = u.mcp_role_id
WHERE u.mcp_role_id IS NOT NULL
ON CONFLICT ("user_id", "role_id", "source") DO NOTHING;

UPDATE invitation_tokens
SET mcp_role_ids = ARRAY[mcp_role_id]
WHERE mcp_role_id IS NOT NULL AND used_at IS NULL;

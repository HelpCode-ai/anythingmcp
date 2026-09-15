-- AlterTable
ALTER TABLE "organization_members" ADD COLUMN     "deactivated_at" TIMESTAMP(3);

-- Reconcile role drift BEFORE the application starts reading the membership
-- role as authoritative. Until this release, PUT /api/users/:id/role wrote
-- users.role only, so for a user's ACTIVE organization the cached column holds
-- the admin's intent and the membership row may be stale. Role sync — the one
-- writer that updates the membership only — is self-hosted-only and re-asserts
-- itself on the next SSO sign-in, so "cache wins" is safe there too.
UPDATE "organization_members" m
SET "role" = u."role"
FROM "users" u
WHERE m."user_id" = u."id"
  AND m."organization_id" = u."organization_id"
  AND m."role" <> u."role";

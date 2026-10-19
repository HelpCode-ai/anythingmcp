-- Accounts whose email addresses differ only in case (or surrounding spaces).
--
-- Read-only: lists the groups the 20261019120000_normalize_user_emails
-- migration left untouched, so an operator can decide by hand which account
-- to keep and move workspaces, memberships and licences onto it. Nothing here
-- changes data.
--
-- Run with:
--   psql "$DATABASE_URL" -f packages/backend/scripts/report-duplicate-emails.sql
--
-- One row per account, grouped by the normalised address; within a group the
-- most recently updated account comes first (the one a sign-in that does not
-- match any spelling exactly will pick).
WITH dup AS (
  SELECT lower(btrim("email")) AS normalized
  FROM "users"
  GROUP BY lower(btrim("email"))
  HAVING count(*) > 1
)
SELECT
  d.normalized,
  u."id"                AS user_id,
  u."email"             AS stored_email,
  u."email_verified",
  u."password_hash" IS NOT NULL AS has_password,
  u."created_at",
  u."updated_at",
  u."first_successful_invocation_at",
  u."organization_id"   AS active_organization_id,
  (SELECT count(*) FROM "organization_members" m WHERE m."user_id" = u."id") AS memberships,
  (SELECT count(*) FROM "organization_members" m WHERE m."user_id" = u."id" AND m."role" = 'ADMIN') AS admin_memberships,
  (
    SELECT string_agg(l."plan" || ':' || l."status", ', ' ORDER BY l."created_at")
    FROM "licenses" l
    WHERE l."organization_id" = u."organization_id"
  ) AS active_org_licences
FROM dup d
JOIN "users" u ON lower(btrim(u."email")) = d.normalized
ORDER BY d.normalized, u."updated_at" DESC, u."created_at" DESC;

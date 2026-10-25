-- Credential health on a connector. When a provider refuses a credential for
-- good (an OAuth2 refresh token answered invalid_grant, a Meta token whose
-- session was logged out), every call asked the token endpoint or the API
-- again: one workspace's scheduled job sent 18 refused refreshes an hour to
-- Google for a day. The status lets calls fail fast with the fix, the
-- dashboard show it, and the owner be emailed once. Nullable columns without
-- a default: a catalog-only change in Postgres, no table rewrite.
ALTER TABLE "connectors" ADD COLUMN "auth_status" TEXT;
ALTER TABLE "connectors" ADD COLUMN "auth_status_code" TEXT;
ALTER TABLE "connectors" ADD COLUMN "auth_status_message" TEXT;
ALTER TABLE "connectors" ADD COLUMN "auth_status_at" TIMESTAMP(3);
ALTER TABLE "connectors" ADD COLUMN "auth_status_ref" TEXT;
ALTER TABLE "connectors" ADD COLUMN "auth_notified_at" TIMESTAMP(3);
ALTER TABLE "connectors" ADD COLUMN "token_expires_at" TIMESTAMP(3);

-- =============================================================================
-- Migration: per-user connector credentials (Enterprise)
-- =============================================================================
-- `connectors.credential_scope` says whose credential a connector's calls
-- carry: SHARED (the one stored on the connector, as before; the default for
-- every existing row) or USER (each caller's own sign-in to the provider).
--
-- `user_connector_credentials` holds those per-user sign-ins: the tokens the
-- provider issued to one user for one connector, encrypted with
-- ENCRYPTION_KEY like `connectors.auth_config`, and the credential health of
-- that one user (auth_status*), so a revoked token blocks only its owner.
-- Rows go away with the connector, the user or the organization.
--
-- Adding the column is instant (a constant default rewrites nothing), but it
-- needs an exclusive lock on `connectors`. Waiting for it behind a transaction
-- that is still open on the table (a token refresh holds one for up to 10 s
-- while the provider answers) would stall every connector query queued behind
-- the wait, for the whole time. So the lock is asked for 1 s at a time: if it
-- is not free, the attempt gives up, the queued queries run, and it tries
-- again, for up to about two minutes before the migration fails (the release
-- then keeps the old backend serving).
-- =============================================================================

-- CreateEnum
CREATE TYPE "CredentialScope" AS ENUM ('SHARED', 'USER');

-- AlterTable
DO $$
DECLARE
  attempt int := 0;
BEGIN
  LOOP
    BEGIN
      PERFORM set_config('lock_timeout', '1s', true);
      ALTER TABLE "connectors" ADD COLUMN     "credential_scope" "CredentialScope" NOT NULL DEFAULT 'SHARED';
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      attempt := attempt + 1;
      IF attempt >= 60 THEN
        RAISE;
      END IF;
      PERFORM pg_sleep(1);
    END;
  END LOOP;
  PERFORM set_config('lock_timeout', '0', true);
END $$;

-- CreateTable
CREATE TABLE "user_connector_credentials" (
    "id" TEXT NOT NULL,
    "connector_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "auth_config" TEXT NOT NULL,
    "auth_status" TEXT,
    "auth_status_code" TEXT,
    "auth_status_message" TEXT,
    "auth_status_at" TIMESTAMP(3),
    "auth_status_ref" TEXT,
    "auth_notified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_connector_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_connector_credentials_user_id_idx" ON "user_connector_credentials"("user_id");

-- CreateIndex
CREATE INDEX "user_connector_credentials_organization_id_idx" ON "user_connector_credentials"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_connector_credentials_connector_id_user_id_key" ON "user_connector_credentials"("connector_id", "user_id");

-- AddForeignKey
ALTER TABLE "user_connector_credentials" ADD CONSTRAINT "user_connector_credentials_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_connector_credentials" ADD CONSTRAINT "user_connector_credentials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_connector_credentials" ADD CONSTRAINT "user_connector_credentials_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

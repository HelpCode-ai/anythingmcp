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
-- =============================================================================

-- CreateEnum
CREATE TYPE "CredentialScope" AS ENUM ('SHARED', 'USER');

-- AlterTable
ALTER TABLE "connectors" ADD COLUMN     "credential_scope" "CredentialScope" NOT NULL DEFAULT 'SHARED';

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

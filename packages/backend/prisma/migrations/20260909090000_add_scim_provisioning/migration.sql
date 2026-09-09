-- SCIM 2.0 inbound provisioning (Entra ID → /api/scim/v2).

-- AlterTable: identity_providers
ALTER TABLE "identity_providers"
  ADD COLUMN "scim_enabled"         BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "scim_token_hash"      TEXT,
  ADD COLUMN "scim_token_issued_at" TIMESTAMP(3),
  ADD COLUMN "scim_last_request_at" TIMESTAMP(3);

-- One token per provider; the guard looks it up by this index on every request.
CREATE UNIQUE INDEX "identity_providers_scim_token_hash_key" ON "identity_providers"("scim_token_hash");

-- AlterTable: user_identities
ALTER TABLE "user_identities" ADD COLUMN "scim_managed_at" TIMESTAMP(3);

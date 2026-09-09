-- SCIM group state: groups pushed by the directory and their members.
-- Separate from identity_provider_role_mappings on purpose — see schema.prisma.

CREATE TABLE "identity_provider_groups" (
    "id"           TEXT NOT NULL,
    "provider_id"  TEXT NOT NULL,
    "external_id"  TEXT,
    "display_name" TEXT NOT NULL,
    "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"   TIMESTAMP(3) NOT NULL,
    CONSTRAINT "identity_provider_groups_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "identity_provider_groups_provider_id_external_id_key" ON "identity_provider_groups"("provider_id", "external_id");
CREATE INDEX "identity_provider_groups_provider_id_idx" ON "identity_provider_groups"("provider_id");
ALTER TABLE "identity_provider_groups" ADD CONSTRAINT "identity_provider_groups_provider_id_fkey"
  FOREIGN KEY ("provider_id") REFERENCES "identity_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "identity_provider_group_members" (
    "group_id"   TEXT NOT NULL,
    "user_id"    TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "identity_provider_group_members_pkey" PRIMARY KEY ("group_id", "user_id")
);
CREATE INDEX "identity_provider_group_members_user_id_idx" ON "identity_provider_group_members"("user_id");
ALTER TABLE "identity_provider_group_members" ADD CONSTRAINT "identity_provider_group_members_group_id_fkey"
  FOREIGN KEY ("group_id") REFERENCES "identity_provider_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "identity_provider_group_members" ADD CONSTRAINT "identity_provider_group_members_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

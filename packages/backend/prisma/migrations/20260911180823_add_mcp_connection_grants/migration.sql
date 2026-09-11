-- What an OAuth client may SEE through the shared /mcp endpoint, chosen by the
-- user while authorizing it. A filter, never a source of authority: resolution
-- re-reads each target's owning organization from mcp_server_configs and
-- re-checks organization_members on every request, so a row naming another
-- tenant's server concedes nothing.
--
-- Deliberately NOT added to prisma/rls/enable-rls.sql. The row is keyed on the
-- user, not on an organization, and organization_id is null for a
-- server-list grant — an org_isolation policy keyed on app.current_org would
-- hide exactly the rows the resolver needs to evaluate. Isolation for this
-- table lives in the resolver's membership join, which is enforced in SQL.

-- CreateTable
CREATE TABLE "mcp_connection_grants" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "organization_id" TEXT,
    "server_ids" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mcp_connection_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mcp_connection_grants_user_id_idx" ON "mcp_connection_grants"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "mcp_connection_grants_client_id_user_id_key" ON "mcp_connection_grants"("client_id", "user_id");

-- AddForeignKey
ALTER TABLE "mcp_connection_grants" ADD CONSTRAINT "mcp_connection_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_connection_grants" ADD CONSTRAINT "mcp_connection_grants_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

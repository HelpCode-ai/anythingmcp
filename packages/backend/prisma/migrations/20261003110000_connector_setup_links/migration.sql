-- One-time links that finish a connector's setup in the dashboard, handed to
-- the user by an AI client that installed the connector through MCP. Only the
-- token's SHA-256 is stored; see the model comment.
CREATE TABLE "connector_setup_links" (
    "id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "connector_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),

    CONSTRAINT "connector_setup_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "connector_setup_links_token_hash_key" ON "connector_setup_links"("token_hash");
CREATE INDEX "connector_setup_links_connector_id_user_id_idx" ON "connector_setup_links"("connector_id", "user_id");
CREATE INDEX "connector_setup_links_expires_at_idx" ON "connector_setup_links"("expires_at");

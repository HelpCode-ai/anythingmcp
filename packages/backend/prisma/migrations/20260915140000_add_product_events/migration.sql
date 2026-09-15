-- =============================================================================
-- Migration: Add product_events (UI usage events for the activation funnel)
-- =============================================================================
-- Records what a user does on the pages that lead to the first MCP call:
-- copied the endpoint, opened a client tab, generated a key, left without
-- copying anything. `tool_invocations` cannot host these (tool_id NOT NULL)
-- and `security_events` is an audit trail, not a product log.
--
-- FKs are ON DELETE SET NULL so deleting a user or organization keeps the
-- aggregate counts intact.
-- =============================================================================

CREATE TABLE "product_events" (
    "id"              TEXT NOT NULL,
    "event"           TEXT NOT NULL,
    "organization_id" TEXT,
    "user_id"         TEXT,
    "metadata"        JSONB,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "product_events_organization_id_created_at_idx" ON "product_events"("organization_id", "created_at");
CREATE INDEX "product_events_event_created_at_idx"           ON "product_events"("event", "created_at");

ALTER TABLE "product_events" ADD CONSTRAINT "product_events_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "product_events" ADD CONSTRAINT "product_events_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

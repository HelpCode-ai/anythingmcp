-- =============================================================================
-- Migration: webhook ingestion
-- =============================================================================
-- Inbound webhooks for connectors that have them (Stripe first). Additive and
-- off by default, so this is a no-op for existing installs:
--
--   * connectors.webhook_enabled/provider/secret — opt-in per connector,
--                                                   regardless of its type.
--                                                   webhook_secret is
--                                                   encrypted the same way
--                                                   auth_config is.
--   * webhook_events                             — one row per verified
--                                                   delivery, org-scoped like
--                                                   every audit table. A
--                                                   retention sweep plus a
--                                                   per-connector cap on
--                                                   insert keep it bounded.
--
-- The ADD COLUMNs use constant defaults, which Postgres applies as a
-- metadata-only change (no table rewrite).
-- =============================================================================

-- AlterTable
ALTER TABLE "connectors" ADD COLUMN     "webhook_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "webhook_provider" TEXT,
ADD COLUMN     "webhook_secret" TEXT;

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" TEXT NOT NULL,
    "connector_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "event_type" TEXT,
    "external_id" TEXT,
    "payload" JSONB NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "webhook_events_connector_id_received_at_idx" ON "webhook_events"("connector_id", "received_at");

-- CreateIndex
CREATE INDEX "webhook_events_organization_id_received_at_idx" ON "webhook_events"("organization_id", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_connector_id_external_id_key" ON "webhook_events"("connector_id", "external_id");

-- AddForeignKey
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

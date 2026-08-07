-- =============================================================================
-- Migration: Add security_events (authentication / authorization audit trail)
-- =============================================================================
-- Append-only trail for auth events. `tool_invocations` cannot host these: its
-- `tool_id` is NOT NULL with an FK to `mcp_tools`, so events like a rejected
-- token or an SSO-driven role change have nowhere to go today and only reach
-- the application logs.
--
-- `organization_id` is nullable BY DESIGN: the most security-relevant events
-- (a forged token, a login for an unknown user) occur before an org can be
-- resolved. Keeping them with a null org is better than dropping them.
--
-- All FKs are ON DELETE SET NULL, never CASCADE: removing a user or an
-- organization must not erase the record of what happened.
--
-- Deliberately NOT added to prisma/rls/enable-rls.sql — see the note on the
-- SecurityEvent model in schema.prisma.
-- =============================================================================

CREATE TABLE "security_events" (
    "id"              TEXT NOT NULL,
    "event"           TEXT NOT NULL,
    "actor_type"      TEXT NOT NULL,
    "organization_id" TEXT,
    "actor_user_id"   TEXT,
    "target_user_id"  TEXT,
    "metadata"        JSONB,
    "ip"              TEXT,
    "user_agent"      TEXT,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "security_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "security_events_organization_id_created_at_idx" ON "security_events"("organization_id", "created_at");
CREATE INDEX "security_events_event_created_at_idx"          ON "security_events"("event", "created_at");
CREATE INDEX "security_events_actor_user_id_created_at_idx"  ON "security_events"("actor_user_id", "created_at");
CREATE INDEX "security_events_target_user_id_created_at_idx" ON "security_events"("target_user_id", "created_at");

ALTER TABLE "security_events" ADD CONSTRAINT "security_events_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_actor_user_id_fkey"
    FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_target_user_id_fkey"
    FOREIGN KEY ("target_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

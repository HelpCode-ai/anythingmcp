-- =============================================================================
-- Migration: Cloud social sign-in (Google, Microsoft, GitHub)
-- =============================================================================
-- `social_identities` links a user to an account at a platform-wide provider.
-- Keyed on (provider, subject), never on the email, which is display-only.
-- Separate from `user_identities`, whose providers belong to one organization.
--
-- `social_login_attempts` holds the per-round-trip state (CSRF `state`, nonce,
-- PKCE verifier, a hash of the browser-binding cookie). Consumed exactly once.
-- The session token is never stored: only `resolved_user_id` and a hash of the
-- one-time handoff code the dashboard exchanges.
--
-- Both tables are empty until the SOCIAL_* environment variables are set, and
-- neither is organization-scoped, so they stay out of row-level security.
-- =============================================================================

-- CreateTable
CREATE TABLE "social_identities" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "tenant_id" TEXT,
    "email" TEXT,
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "social_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "social_login_attempts" (
    "id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "code_verifier" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "surface" TEXT NOT NULL,
    "browser_binding_hash" TEXT NOT NULL,
    "link_user_id" TEXT,
    "oauth_session_id" TEXT,
    "return_to" TEXT,
    "attribution" JSONB,
    "handoff_code_hash" TEXT,
    "resolved_user_id" TEXT,
    "is_new_user" BOOLEAN NOT NULL DEFAULT false,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "social_login_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "social_identities_user_id_idx" ON "social_identities"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "social_identities_provider_subject_key" ON "social_identities"("provider", "subject");

-- CreateIndex
CREATE UNIQUE INDEX "social_identities_user_id_provider_key" ON "social_identities"("user_id", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "social_login_attempts_state_key" ON "social_login_attempts"("state");

-- CreateIndex
CREATE UNIQUE INDEX "social_login_attempts_handoff_code_hash_key" ON "social_login_attempts"("handoff_code_hash");

-- CreateIndex
CREATE INDEX "social_login_attempts_expires_at_idx" ON "social_login_attempts"("expires_at");

-- AddForeignKey
ALTER TABLE "social_identities" ADD CONSTRAINT "social_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

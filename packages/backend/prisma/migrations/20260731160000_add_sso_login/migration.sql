-- =============================================================================
-- Migration: SSO sign-in — federated identities + per-attempt server state
-- =============================================================================
-- `user_identities` links a local user to an identity at an external provider.
-- The key is (provider_id, external_subject) and NEVER the email: Entra's
-- `mail` attribute is mutable, unverified and not unique, and Microsoft states
-- plainly that it must not be used for authorization or as a primary
-- identifier. Keying on it is the nOAuth vulnerability.
--
-- `sso_login_attempts` holds everything security-relevant for one round trip to
-- the provider — the CSRF `state`, the replay-guarding `nonce` and the PKCE
-- verifier — rather than putting it in a cookie that must survive the hop to
-- the IdP and back. Consumed atomically exactly once.
--
-- The minted session token is never stored: on success the row records only
-- `resolved_user_id`, and the JWT is created when the one-time `handoff_code`
-- is exchanged. Nothing bearer-shaped sits at rest.
-- =============================================================================

CREATE TABLE "user_identities" (
    "id"               TEXT NOT NULL,
    "user_id"          TEXT NOT NULL,
    "provider_id"      TEXT NOT NULL,
    -- Entra: the `oid` claim.
    "external_subject" TEXT NOT NULL,
    -- Entra: the `tid` claim, so a tenant change becomes detectable.
    "external_tid"     TEXT,
    "last_login_at"    TIMESTAMP(3),
    "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_identities_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_identities_provider_id_external_subject_key"
    ON "user_identities"("provider_id", "external_subject");
CREATE INDEX "user_identities_user_id_idx" ON "user_identities"("user_id");

ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_provider_id_fkey"
    FOREIGN KEY ("provider_id") REFERENCES "identity_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "sso_login_attempts" (
    "id"                TEXT NOT NULL,
    "state"             TEXT NOT NULL,
    "nonce"             TEXT NOT NULL,
    "code_verifier"     TEXT NOT NULL,
    "provider_id"       TEXT NOT NULL,
    "surface"           TEXT NOT NULL DEFAULT 'DASHBOARD',
    -- Validated against an allowlist of internal paths before use; an
    -- unchecked value here is an open redirect.
    "return_to"         TEXT,
    -- PR 4: recorded so the callback can ASSERT the browser is the same one
    -- that started the MCP flow — never to restore the cookies, which would
    -- reduce mcp-nest's only binding check to `x === x`.
    "oauth_session_id"  TEXT,
    "oauth_state_value" TEXT,
    "handoff_code"      TEXT,
    "resolved_user_id"  TEXT,
    "expires_at"        TIMESTAMP(3) NOT NULL,
    "consumed_at"       TIMESTAMP(3),
    "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sso_login_attempts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sso_login_attempts_state_key"        ON "sso_login_attempts"("state");
CREATE UNIQUE INDEX "sso_login_attempts_handoff_code_key" ON "sso_login_attempts"("handoff_code");
CREATE INDEX "sso_login_attempts_provider_id_idx"         ON "sso_login_attempts"("provider_id");
CREATE INDEX "sso_login_attempts_expires_at_idx"          ON "sso_login_attempts"("expires_at");

ALTER TABLE "sso_login_attempts" ADD CONSTRAINT "sso_login_attempts_provider_id_fkey"
    FOREIGN KEY ("provider_id") REFERENCES "identity_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

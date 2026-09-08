-- =============================================================================
-- Migration: Add session revocation + password-login gate to users
-- =============================================================================
-- Tokens are stateless JWTs and `/revoke` is advertised but unimplemented, so
-- nothing could be revoked before its natural expiry (24h for a dashboard
-- token, longer for an MCP refresh token).
--
-- `sessions_valid_from` is a cutover instant: any token whose `iat` predates it
-- is refused. Deliberately a timestamp and NOT an epoch counter — a counter must
-- be echoed back as a token claim, and MCP access tokens are minted by
-- @rekog/mcp-nest, which cannot be asked to carry one. Every JWT already has
-- `iat`, so one column revokes both token families.
--
-- `password_login_disabled` gates password login AND password reset. Gating only
-- login would leave /api/auth/forgot-password as a way for an SSO-only user with
-- mailbox access to set a password and bypass SSO, MFA and Conditional Access.
--
-- Both are additive with safe defaults, so a running old container is unaffected.
-- =============================================================================

ALTER TABLE "users" ADD COLUMN "sessions_valid_from" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "password_login_disabled" BOOLEAN NOT NULL DEFAULT false;

-- `password_hash` becomes nullable: a user provisioned through an external IdP
-- never has one. Widening a NOT NULL column is safe for a running old container
-- (it only ever reads existing non-null values); nothing writes NULL until SSO
-- provisioning lands.
ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;

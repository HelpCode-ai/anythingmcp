-- =============================================================================
-- Migration: link an existing account to an external identity
-- =============================================================================
-- With just-in-time provisioning off — the default, and the safe one — a member
-- who already has an account could never sign in through the provider: the
-- callback looks up `user_identities` by (provider_id, external_subject), finds
-- nothing, and refuses. Deliberately so, because the alternative is matching on
-- the IdP-supplied email, which is the nOAuth takeover.
--
-- The missing half is an explicit, authenticated link. `link_user_id` records
-- WHO started that round trip, taken from their session at start time. It is
-- never read from the callback: everything arriving there is under the control
-- of whoever holds the authorization code.
-- =============================================================================

ALTER TABLE "sso_login_attempts" ADD COLUMN "link_user_id" TEXT;

-- One identity per provider per user. Without it a user could accumulate
-- several accounts at the same provider and `DELETE /link/:providerId` would
-- have no single row to remove, silently leaving one behind — an unlink that
-- reports success while access survives.
--
-- Safe to add unconditionally: the feature has never shipped, so no row exists
-- that could violate it. Should that ever stop being true, this statement fails
-- loudly rather than dropping data.
CREATE UNIQUE INDEX "user_identities_user_id_provider_id_key"
    ON "user_identities"("user_id", "provider_id");

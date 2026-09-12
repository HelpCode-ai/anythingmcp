import { PrismaService } from '../common/prisma.service';

/**
 * Resolves the `users.id` cuid a token belongs to, WITHOUT ever trusting an
 * email claim.
 *
 * Tokens minted after LocalOAuthProvider started mapping the profile `username`
 * to the cuid carry it directly in `sub`.
 *
 * Tokens minted BEFORE that carry the user's email in `sub` — but they also
 * carry `user_profile_id`, and `oauth_user_profiles.external_id` has always
 * stored the cuid (PrismaOAuthStore.upsertUserProfile writes
 * `externalId: profile.id`, and `profile.id` comes from the login cookie's
 * `user.id`). So the cuid is recoverable from authoritative server state, keyed
 * by an opaque identifier that is bound to the signed token.
 *
 * That is why no legacy email fallback is needed: previously-issued sessions
 * keep working, and the mutable, IdP-supplied `email` claim never takes part in
 * identity resolution.
 *
 * SECURITY: this logic must exist in exactly one place. It is the fix for the
 * nOAuth class of bug — an email-keyed lookup would let anyone able to
 * influence an IdP profile resolve to another organization's user. Both the
 * MCP request guard and the refresh-grant middleware call in here; do not
 * reimplement it at a third site.
 */
export async function resolveUserIdFromTokenPayload(
  prisma: PrismaService,
  payload: { sub?: string; user_profile_id?: string } | null | undefined,
): Promise<string | undefined> {
  const sub: string | undefined = payload?.sub;

  // Modern tokens: `sub` is already the cuid. Emails are the only other shape
  // we have ever put there, so an '@' is a reliable discriminator.
  if (sub && !sub.includes('@')) return sub;

  const profileId: string | undefined = payload?.user_profile_id;
  if (profileId) {
    const profile = await prisma.oAuthUserProfile.findUnique({
      where: { profileId },
      select: { externalId: true },
    });
    if (profile?.externalId) return profile.externalId;
  }

  // Legacy token with no recoverable profile → fail closed. Returning the email
  // here would reintroduce the email-keyed lookup this function exists to
  // remove.
  return undefined;
}

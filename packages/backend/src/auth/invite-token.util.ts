import { createHash, randomBytes } from 'crypto';

/**
 * Invitation links carry a random token; the database keeps only its SHA-256
 * (hex), marked with this prefix. The prefix tells a stored hash apart from
 * a token stored in plain text by an earlier release, which is still
 * accepted until it expires (48 hours after it was created).
 */
export const INVITE_TOKEN_HASH_PREFIX = 'sha256:';

/** A new token for an invitation link (32 random bytes, hex). */
export function newInviteToken(): string {
  return randomBytes(32).toString('hex');
}

/** What is stored in `invitation_tokens.token` for a token. */
export function hashInviteToken(token: string): string {
  return `${INVITE_TOKEN_HASH_PREFIX}${createHash('sha256').update(token).digest('hex')}`;
}

/** Whether a stored value is a hash written by this release (not a plain token). */
export function isHashedInviteToken(stored: string): boolean {
  return stored.startsWith(INVITE_TOKEN_HASH_PREFIX);
}

interface InvitationLookup<T extends { token: string }> {
  invitationToken: { findUnique(args: { where: { token: string } }): Promise<T | null> };
}

/**
 * The invitation a link's token belongs to, or null. Looked up by hash; a
 * row written in plain text by an earlier release matches the token itself.
 * A stored hash presented as the token never matches: the plain lookup only
 * accepts rows that are not hashes.
 */
export async function findInvitationByToken<T extends { token: string }>(
  prisma: InvitationLookup<T>,
  token: unknown,
): Promise<T | null> {
  if (typeof token !== 'string' || !token || isHashedInviteToken(token)) return null;
  const hashed = await prisma.invitationToken.findUnique({ where: { token: hashInviteToken(token) } });
  if (hashed) return hashed;
  const legacy = await prisma.invitationToken.findUnique({ where: { token } });
  if (legacy && !isHashedInviteToken(legacy.token)) return legacy;
  return null;
}

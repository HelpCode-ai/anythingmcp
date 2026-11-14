import { createHmac, hkdfSync } from 'node:crypto';
import { getRequiredSecret } from '../secrets.util';

/**
 * At-rest form of a per-user `mcp_` API key.
 *
 * A key is a bearer credential with 256 bits of entropy, so it is stored as a
 * keyed hash, never in plaintext: `HMAC-SHA256(pepper, key)` as hex. The
 * pepper is derived from ENCRYPTION_KEY with HKDF, so a copy of the database
 * alone cannot be used to check guesses, and no extra secret has to be
 * configured (self-hosted instances get it from the key they already have).
 *
 * ENCRYPTION_KEY must never change: changing it would invalidate every stored
 * API key hash, as it already makes stored connector credentials unreadable.
 * The info string versions the derivation; never edit it in place.
 */
const HKDF_INFO = 'amcp:mcp-api-key:v1';

/** Number of trailing characters kept in clear for the masked display. */
export const API_KEY_SUFFIX_LENGTH = 8;

const peppers = new Map<string, Buffer>();

/** HKDF-SHA256 pepper for API key hashes, derived from ENCRYPTION_KEY. */
export function apiKeyPepper(encryptionKey: string = process.env.ENCRYPTION_KEY ?? ''): Buffer {
  const secret = getRequiredSecret('ENCRYPTION_KEY', encryptionKey);
  let pepper = peppers.get(secret);
  if (!pepper) {
    pepper = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), HKDF_INFO, 32));
    peppers.set(secret, pepper);
  }
  return pepper;
}

/** The value stored in `mcp_api_keys.key_hash` for a presented key. */
export function hashApiKey(key: string, pepper: Buffer = apiKeyPepper()): string {
  return createHmac('sha256', pepper).update(key, 'utf8').digest('hex');
}

/** The last characters of a key, kept for `mcp_••••<suffix>` in the UI. */
export function apiKeySuffix(key: string): string {
  return key.slice(-API_KEY_SUFFIX_LENGTH);
}

/**
 * Prisma `where` that finds the key row for a presented key.
 *
 * Transition (phase 1 of the hashing rollout): rows are matched by hash, and
 * by the plaintext column for rows not backfilled yet. Both columns are
 * unique, so at most one row matches. The plaintext branch is removed when
 * the column is dropped.
 */
export function apiKeyLookupWhere(key: string, pepper: Buffer = apiKeyPepper()) {
  return { OR: [{ keyHash: hashApiKey(key, pepper) }, { key }] };
}

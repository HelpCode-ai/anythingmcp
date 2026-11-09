import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'crypto';
import { getRequiredSecret } from '../common/secrets.util';

/**
 * The token of the no-login reactivation page (`/reactivate/<token>` on the
 * Cloud frontend), given to an AI client when an ended trial blocks a tool
 * call (one arm of the reactivation-link test, license-checkout.ts).
 *
 * It names the workspace and, when known, the user whose AI made the call:
 * ids only, never an address, since the link travels through the AI
 * provider's logs. The ids and an expiry are encrypted with AES-256-GCM, so
 * the token reveals nothing and cannot be forged or edited. Holding one shows
 * the workspace's name, its trial state and its counts, and opens a checkout
 * for its administrator; nothing else.
 *
 * Format, as email-link-token.ts: version byte, 12-byte IV, ciphertext of
 * `{"o":<org>,"u":<user>?,"x":<expiry, unix seconds>}`, 16-byte tag, base64url.
 * The key is derived with HKDF-SHA256 from ENCRYPTION_KEY, which every server
 * already has; the info string versions the derivation, never edit it in place.
 */

/** How long a link keeps working after the call that produced it. */
export const REACTIVATION_LINK_TTL_DAYS = 30;

const HKDF_INFO = 'anythingmcp/reactivate-link/v1';
const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Two cuids and an expiry make about 140 characters; anything far longer is not ours. */
export const MAX_REACTIVATION_TOKEN_LENGTH = 512;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export interface ReactivationTokenPayload {
  organizationId: string;
  userId: string | null;
}

const keys = new Map<string, Buffer>();

function linkKey(env: Record<string, string | undefined>): Buffer | null {
  const root = env.ENCRYPTION_KEY;
  if (!root) return null;
  let key = keys.get(root);
  if (!key) {
    try {
      getRequiredSecret('ENCRYPTION_KEY', root);
    } catch {
      return null;
    }
    key = Buffer.from(hkdfSync('sha256', root, Buffer.alloc(0), HKDF_INFO, 32));
    keys.set(root, key);
  }
  return key;
}

/** The token for a workspace (and user), or null without a usable ENCRYPTION_KEY or a valid id. */
export function createReactivationToken(
  input: { organizationId: string; userId?: string | null },
  now: Date = new Date(),
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (!ID_RE.test(input.organizationId ?? '')) return null;
  const key = linkKey(env);
  if (!key) return null;
  const userId = input.userId && ID_RE.test(input.userId) ? input.userId : undefined;
  const payload = JSON.stringify({
    o: input.organizationId,
    ...(userId ? { u: userId } : {}),
    x: Math.floor(now.getTime() / 1000) + REACTIVATION_LINK_TTL_DAYS * 86400,
  });
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, body, cipher.getAuthTag()]).toString('base64url');
}

/** The workspace and user a token names, or null for anything expired, altered, oversized or not ours. */
export function readReactivationToken(
  token: unknown,
  now: Date = new Date(),
  env: Record<string, string | undefined> = process.env,
): ReactivationTokenPayload | null {
  if (typeof token !== 'string' || token.length < 20 || token.length > MAX_REACTIVATION_TOKEN_LENGTH) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(token)) return null;
  const key = linkKey(env);
  if (!key) return null;
  try {
    const raw = Buffer.from(token, 'base64url');
    if (raw.length < 1 + IV_BYTES + TAG_BYTES + 1 || raw[0] !== VERSION) return null;
    const iv = raw.subarray(1, 1 + IV_BYTES);
    const tag = raw.subarray(raw.length - TAG_BYTES);
    const body = raw.subarray(1 + IV_BYTES, raw.length - TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const payload = JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8'));
    if (typeof payload?.o !== 'string' || !ID_RE.test(payload.o)) return null;
    if (typeof payload?.x !== 'number' || payload.x * 1000 <= now.getTime()) return null;
    const userId = typeof payload.u === 'string' && ID_RE.test(payload.u) ? payload.u : null;
    return { organizationId: payload.o, userId };
  } catch {
    return null;
  }
}

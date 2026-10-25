import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'crypto';

/**
 * The address token the licence site (anythingmcp.com) reads from pricing
 * links: `/pricing#t=<token>`. Byte for byte the format of the site's
 * lib/email-link-token.ts, which also mints it for its own emails.
 *
 * With it, the site knows who is buying without the address appearing in the
 * URL: it prefills Stripe Checkout with the address and, since 15 Oct 2026,
 * refuses a second subscription to an address that already has a card trial
 * or a plan (the site's lib/duplicate-checkout.ts). Without it a pricing link
 * is anonymous, and the site cannot tell a card-trial holder from a new buyer:
 * on 14 Oct 2026 three Cloud card-trial holders bought Cloud Starter again
 * from this server's trial emails.
 *
 * The token is the lower-cased address and an expiry, encrypted with
 * AES-256-GCM. It reveals nothing by itself and cannot be forged or edited;
 * holding one lets you start a checkout prefilled with that address, nothing
 * else. It travels in the URL fragment, which browsers do not send to servers
 * or in Referer headers.
 *
 * The key is derived from EMAIL_LINK_SECRET, which must hold the same value
 * here and on the licence site. Unset, no token is made and links go out
 * without one, as before. (The site falls back to its Stripe secret key when
 * EMAIL_LINK_SECRET is unset there; this server never holds that key.)
 */

/** As on the site: long enough for the last win-back email and some reading time. */
export const EMAIL_LINK_TTL_DAYS = 45;

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

function linkKey(env: Record<string, string | undefined>): Buffer | null {
  const root = env.EMAIL_LINK_SECRET;
  if (!root) return null;
  return createHmac('sha256', root).update('anythingmcp/email-link/v1').digest();
}

/** The token for an address, or null when EMAIL_LINK_SECRET is unset or the address is empty. */
export function createEmailLinkToken(
  email: string | null | undefined,
  now: Date = new Date(),
  env: Record<string, string | undefined> = process.env,
): string | null {
  const address = email?.trim().toLowerCase();
  if (!address) return null;
  const key = linkKey(env);
  if (!key) return null;
  const payload = JSON.stringify({
    e: address,
    x: Math.floor(now.getTime() / 1000) + EMAIL_LINK_TTL_DAYS * 86400,
  });
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, body, cipher.getAuthTag()]).toString('base64url');
}

/**
 * The address inside a token, or null for anything expired, altered or not
 * made with this key. The site does the reading; this is here so the format
 * can be tested against it.
 */
export function readEmailLinkToken(
  token: unknown,
  now: Date = new Date(),
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (typeof token !== 'string' || token.length < 20 || token.length > 1024) return null;
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
    if (typeof payload?.e !== 'string' || typeof payload?.x !== 'number') return null;
    if (payload.x * 1000 < now.getTime()) return null;
    return payload.e;
  } catch {
    return null;
  }
}

/** `url` with the address token in its fragment (`#t=…`), or unchanged without one. */
export function withEmailLinkToken(url: string, token: string | null | undefined): string {
  if (!token) return url;
  return `${url.split('#')[0]}#t=${token}`;
}

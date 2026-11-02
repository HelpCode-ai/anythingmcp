import { createHmac, timingSafeEqual } from 'crypto';

/**
 * The bearer token of the one-click trial extension link
 * (`/api/license/extend?token=…`), sent in the Cloud "your trial has ended"
 * email to business workspaces.
 *
 * `<organizationId>.<expiry, unix seconds>.<HMAC-SHA256 of both>`, base64url
 * signature. It names the workspace and nothing else: the licence key stays
 * on the server. It expires 7 days after the trial ended, when the licence
 * site stops granting the extension anyway.
 *
 * Keyed on a value derived from JWT_SECRET, like the unsubscribe links: only
 * this server mints and reads these, it is always set on a running server,
 * and the derivation keeps the key distinct from every other token.
 */

/** How long after the trial ended the link works (the site's window too). */
export const TRIAL_EXTENSION_LINK_DAYS = 7;

const ORG_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function key(secret: string): Buffer {
  return createHmac('sha256', secret).update('amcp-trial-extension-v1').digest();
}

export function trialExtensionSecret(env: Record<string, string | undefined> = process.env): string | null {
  return env.JWT_SECRET || null;
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', key(secret)).update(payload).digest('base64url');
}

/** The token for a workspace whose trial ended at `trialEndedAt`, or null without a valid id. */
export function createTrialExtensionToken(organizationId: string, trialEndedAt: Date, secret: string): string | null {
  if (!ORG_ID_RE.test(organizationId)) return null;
  const expiry = Math.floor(trialEndedAt.getTime() / 1000) + TRIAL_EXTENSION_LINK_DAYS * 86400;
  const payload = `${organizationId}.${expiry}`;
  return `${payload}.${sign(payload, secret)}`;
}

export type TrialExtensionTokenCheck =
  | { ok: true; organizationId: string }
  | { ok: false; reason: 'invalid' | 'expired' };

/** The workspace a token names, or why it does not count. */
export function readTrialExtensionToken(
  token: unknown,
  secret: string,
  now: Date = new Date(),
): TrialExtensionTokenCheck {
  if (typeof token !== 'string' || token.length > 300) return { ok: false, reason: 'invalid' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'invalid' };
  const [organizationId, expiryRaw, signature] = parts;
  if (!ORG_ID_RE.test(organizationId) || !/^\d{1,12}$/.test(expiryRaw)) return { ok: false, reason: 'invalid' };
  const expected = Buffer.from(sign(`${organizationId}.${expiryRaw}`, secret));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: 'invalid' };
  if (Number(expiryRaw) * 1000 <= now.getTime()) return { ok: false, reason: 'expired' };
  return { ok: true, organizationId };
}

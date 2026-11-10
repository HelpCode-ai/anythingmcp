import { createHmac } from 'node:crypto';
import { findUnresolvedPlaceholders } from '../../common/unresolved-placeholders.util';

/**
 * A short-lived JWT signed with a shared secret (HS256/384/512) and sent on
 * every request, for APIs that never accept the key itself.
 *
 * Ghost's Admin API is the first user: its Admin API key is `<id>:<secret>`,
 * and each request must carry `Authorization: Ghost <jwt>`, where the JWT has
 * `kid` = the id, is signed with the hex-decoded secret, has `aud: "/admin/"`
 * and lives at most 5 minutes. The adapter used to ask the user for a JWT
 * they had generated themselves, so every Ghost connector stopped working
 * five minutes after setup (a customer hit it on 2026-11-09).
 *
 * Configured on an `authType: "HMAC"` connector:
 *
 *   "signature": {
 *     "jwt": {
 *       "key": "{{GHOST_ADMIN_API_KEY}}",  // "<id>:<secret>" (keyFormat below)
 *       "keyFormat": "id:secret",          // or give "keyId" and "secret" apart
 *       "secretEncoding": "hex",           // utf8 (default) | hex | base64
 *       "algorithm": "HS256",              // default; HS384 | HS512
 *       "ttlSeconds": 300,                 // default 300, at most 3600
 *       "claims": { "aud": "/admin/" }     // added to iat and exp
 *     },
 *     "headerName": "Authorization",       // default Authorization
 *     "headerTemplate": "Ghost ${jwt}"     // default "Bearer ${jwt}"
 *   }
 *
 * A fresh token is signed for each request (and for a retry), so the
 * connector only stores the key, never a token that expires.
 */

const ALGORITHMS = { HS256: 'sha256', HS384: 'sha384', HS512: 'sha512' } as const;
type Algorithm = keyof typeof ALGORITHMS;

const DEFAULT_TTL_SECONDS = 300;
const MAX_TTL_SECONDS = 3600;

/** An error whose message is safe to show: it never contains key material. */
export class HmacJwtError extends Error {
  constructor(message: string) {
    super(`signed JWT: ${message}`);
    this.name = 'HmacJwtError';
  }
}

export function isHmacJwtSignature(sig: Record<string, unknown> | undefined): boolean {
  return !!sig && !!sig.jwt && typeof sig.jwt === 'object' && !Array.isArray(sig.jwt);
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function decodeSecret(secret: string, encoding: unknown): Buffer {
  const enc = String(encoding ?? 'utf8');
  if (enc === 'hex') {
    if (!/^(?:[0-9a-fA-F]{2})+$/.test(secret)) {
      throw new HmacJwtError('the secret is not hexadecimal: copy the whole key again, without spaces');
    }
    return Buffer.from(secret, 'hex');
  }
  if (enc === 'base64') return Buffer.from(secret, 'base64');
  return Buffer.from(secret, 'utf8');
}

/**
 * The key id and secret, from either `key` + `keyFormat: "id:secret"` or the
 * separate `keyId` and `secret` fields. Errors name the field, never a value.
 */
function keyParts(cfg: Record<string, unknown>): { keyId?: string; secret: string } {
  if (cfg.key !== undefined) {
    const key = String(cfg.key ?? '').trim();
    const unresolved = findUnresolvedPlaceholders(key);
    if (!key || unresolved.length > 0) {
      throw new HmacJwtError(
        unresolved.length > 0
          ? `the key is not set (${unresolved.map((v) => `{{${v}}}`).join(', ')} has no value)`
          : 'the key is empty',
      );
    }
    if (String(cfg.keyFormat ?? 'id:secret') !== 'id:secret') {
      throw new HmacJwtError(`keyFormat "${String(cfg.keyFormat)}" is not supported (use "id:secret")`);
    }
    const colon = key.indexOf(':');
    if (colon <= 0 || colon === key.length - 1) {
      throw new HmacJwtError('the key must look like <id>:<secret>, with the colon in the middle');
    }
    return { keyId: key.slice(0, colon), secret: key.slice(colon + 1) };
  }
  const secret = String(cfg.secret ?? '');
  const unresolved = findUnresolvedPlaceholders(secret);
  if (!secret || unresolved.length > 0) {
    throw new HmacJwtError(
      unresolved.length > 0
        ? `the secret is not set (${unresolved.map((v) => `{{${v}}}`).join(', ')} has no value)`
        : 'no secret is configured',
    );
  }
  const keyId = typeof cfg.keyId === 'string' && cfg.keyId ? cfg.keyId : undefined;
  return { keyId, secret };
}

/** Signs one JWT from a `signature.jwt` block. `nowMs` is for tests. */
export function signHmacJwt(cfg: Record<string, unknown>, nowMs: number = Date.now()): string {
  const algorithm = String(cfg.algorithm ?? 'HS256') as Algorithm;
  const hash = ALGORITHMS[algorithm];
  if (!hash) {
    throw new HmacJwtError(`algorithm "${String(cfg.algorithm)}" is not supported (HS256, HS384 or HS512)`);
  }
  const { keyId, secret } = keyParts(cfg);
  const secretBytes = decodeSecret(secret, cfg.secretEncoding);

  const ttlRaw = Number(cfg.ttlSeconds);
  const ttl = Math.min(
    Number.isFinite(ttlRaw) && ttlRaw > 0 ? Math.floor(ttlRaw) : DEFAULT_TTL_SECONDS,
    MAX_TTL_SECONDS,
  );
  const iat = Math.floor(nowMs / 1000);
  const extra =
    cfg.claims && typeof cfg.claims === 'object' && !Array.isArray(cfg.claims)
      ? (cfg.claims as Record<string, unknown>)
      : {};

  const header = { alg: algorithm, typ: 'JWT', ...(keyId ? { kid: keyId } : {}) };
  // iat and exp last: a claim in the adapter cannot stretch the lifetime.
  const payload = { ...extra, iat, exp: iat + ttl };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = createHmac(hash, secretBytes).update(signingInput).digest('base64url');
  return `${signingInput}.${signature}`;
}

/** The header name and value a `signature` block with a `jwt` sends. */
export function hmacJwtHeader(
  sig: Record<string, unknown>,
  nowMs: number = Date.now(),
): { name: string; value: string } {
  const token = signHmacJwt(sig.jwt as Record<string, unknown>, nowMs);
  const template = typeof sig.headerTemplate === 'string' ? sig.headerTemplate : 'Bearer ${jwt}';
  return {
    name: typeof sig.headerName === 'string' && sig.headerName ? sig.headerName : 'Authorization',
    value: template.replace(/\$\{jwt\}/g, token),
  };
}

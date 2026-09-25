import { createPrivateKey, randomUUID, sign, type KeyObject } from 'crypto';
import { findUnresolvedPlaceholders } from '../../common/unresolved-placeholders.util';

/**
 * `private_key_jwt` client authentication at an OAuth2 token endpoint
 * (RFC 7523 §2.2, OpenID Connect Core §9).
 *
 * Instead of a client secret, the client proves who it is with a short-lived
 * JWT signed by its own private key; the provider holds the matching public
 * key or certificate. The JWT goes in the form body of every token request —
 * code exchange and refresh alike:
 *
 *   client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer
 *   client_assertion=<signed JWT>
 *
 * A fresh assertion is signed for each request, so the connector only ever
 * stores the key, never a JWT that could expire (Revolut Business, the first
 * user, rejects a refresh with an expired assertion and recommends short
 * lifetimes).
 *
 * Configured in `authConfig`:
 *
 *   "tokenAuthMethod": "private_key_jwt",
 *   "clientAssertion": {
 *     "privateKey": "{{MY_PRIVATE_KEY}}",   // PEM, PKCS#1 or PKCS#8
 *     "algorithm": "RS256",                 // default
 *     "ttlSeconds": 300,                    // default
 *     "keyId": "...",                       // optional `kid` header
 *     "claims": { "iss": "...", "aud": "..." }
 *   }
 *
 * Claims default to what RFC 7523 §3 asks for — `iss` and `sub` are the client
 * id, `aud` is the token endpoint — plus `iat`, `exp` and a random `jti`.
 * `claims` overrides any of them; `exp` is always `iat + ttlSeconds`.
 */

export const PRIVATE_KEY_JWT = 'private_key_jwt';

export const CLIENT_ASSERTION_TYPE =
  'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

export function isPrivateKeyJwt(method: unknown): boolean {
  return method === PRIVATE_KEY_JWT;
}

const DEFAULT_TTL_SECONDS = 300;
/** A provider may cap the lifetime; nothing needs a signed login for longer. */
const MAX_TTL_SECONDS = 3600;

type Algorithm = 'RS256' | 'RS384' | 'RS512' | 'PS256' | 'ES256' | 'ES384';

const ALGORITHMS: Record<
  Algorithm,
  { hash: string; keyType: 'rsa' | 'ec'; pss?: boolean; curve?: string }
> = {
  RS256: { hash: 'sha256', keyType: 'rsa' },
  RS384: { hash: 'sha384', keyType: 'rsa' },
  RS512: { hash: 'sha512', keyType: 'rsa' },
  PS256: { hash: 'sha256', keyType: 'rsa', pss: true },
  ES256: { hash: 'sha256', keyType: 'ec', curve: 'prime256v1' },
  ES384: { hash: 'sha384', keyType: 'ec', curve: 'secp384r1' },
};

export interface ClientAssertionSettings {
  privateKey: string;
  clientId: string;
  tokenUrl: string;
  algorithm?: string;
  ttlSeconds?: number;
  keyId?: string;
  claims?: Record<string, unknown>;
}

/** An error whose message is safe to show: it never contains key material. */
export class ClientAssertionError extends Error {
  constructor(message: string) {
    super(`client assertion: ${message}`);
    this.name = 'ClientAssertionError';
  }
}

/**
 * Reads the `private_key_jwt` settings out of a (resolved) authConfig.
 * Throws a ClientAssertionError naming what is missing.
 */
export function clientAssertionSettingsFrom(
  authConfig: Record<string, unknown>,
  tokenUrl: string,
): ClientAssertionSettings {
  const raw = authConfig.clientAssertion;
  const cfg =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const privateKey = typeof cfg.privateKey === 'string' ? cfg.privateKey : '';
  const clientId =
    typeof authConfig.clientId === 'string' ? authConfig.clientId : '';
  const claims =
    cfg.claims && typeof cfg.claims === 'object' && !Array.isArray(cfg.claims)
      ? (cfg.claims as Record<string, unknown>)
      : undefined;
  const ttl = Number(cfg.ttlSeconds);
  return {
    privateKey,
    clientId,
    tokenUrl,
    algorithm: typeof cfg.algorithm === 'string' ? cfg.algorithm : undefined,
    ttlSeconds: Number.isFinite(ttl) && ttl > 0 ? ttl : undefined,
    keyId: typeof cfg.keyId === 'string' && cfg.keyId ? cfg.keyId : undefined,
    claims,
  };
}

/**
 * Turns whatever the user pasted into a private key.
 *
 * Environment variables are edited in single-line inputs, and browsers strip
 * the line breaks out of a pasted value, so a PEM usually arrives as
 * `-----BEGIN PRIVATE KEY-----MIIEv…-----END PRIVATE KEY-----`. Some tools
 * also store it with literal `\n`. Only the base64 between the armour lines
 * matters, so it is taken from there and decoded as DER.
 */
export function parsePrivateKey(value: string): KeyObject {
  const text = String(value ?? '').replace(/\\n/g, '\n').trim();
  if (!text) throw new ClientAssertionError('no private key is configured');
  const unresolved = findUnresolvedPlaceholders(text);
  if (unresolved.length > 0) {
    throw new ClientAssertionError(
      `the private key is not set (${unresolved.map((v) => `{{${v}}}`).join(', ')} has no value)`,
    );
  }
  const armour = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/.exec(
    text,
  );
  if (!armour) {
    throw new ClientAssertionError(
      'the private key is not a PEM key (expected "-----BEGIN PRIVATE KEY-----" … "-----END PRIVATE KEY-----")',
    );
  }
  const label = armour[1].trim();
  if (label === 'ENCRYPTED PRIVATE KEY' || /Proc-Type:\s*4,ENCRYPTED/.test(armour[2])) {
    throw new ClientAssertionError(
      'the private key is encrypted with a passphrase; export it without one (openssl pkey -in key.pem -out plain.pem)',
    );
  }
  const type =
    label === 'PRIVATE KEY'
      ? 'pkcs8'
      : label === 'RSA PRIVATE KEY'
        ? 'pkcs1'
        : label === 'EC PRIVATE KEY'
          ? 'sec1'
          : null;
  if (!type) {
    throw new ClientAssertionError(
      `expected a private key, got a PEM "${label}" block` +
        (label === 'CERTIFICATE' || label === 'PUBLIC KEY'
          ? ' (that is the public half: paste the private key instead)'
          : ''),
    );
  }
  const der = Buffer.from(armour[2].replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  try {
    return createPrivateKey({ key: der, format: 'der', type });
  } catch {
    throw new ClientAssertionError('the private key could not be read (damaged or incomplete PEM)');
  }
}

const b64url = (input: Buffer | string): string =>
  Buffer.from(input).toString('base64url');

/** Signs a client assertion JWT. `now` is injectable for tests. */
export function signClientAssertion(
  settings: ClientAssertionSettings,
  now: number = Date.now(),
): string {
  const algorithm = (settings.algorithm || 'RS256').toUpperCase() as Algorithm;
  const alg = ALGORITHMS[algorithm];
  if (!alg) {
    throw new ClientAssertionError(
      `unsupported algorithm "${settings.algorithm}" (use one of ${Object.keys(ALGORITHMS).join(', ')})`,
    );
  }
  const key = parsePrivateKey(settings.privateKey);
  if (key.asymmetricKeyType !== alg.keyType) {
    throw new ClientAssertionError(
      `${algorithm} needs an ${alg.keyType.toUpperCase()} key, the configured key is ${String(key.asymmetricKeyType).toUpperCase()}`,
    );
  }

  const ttl = Math.min(
    Math.max(Math.floor(settings.ttlSeconds ?? DEFAULT_TTL_SECONDS), 1),
    MAX_TTL_SECONDS,
  );
  const iat = Math.floor(now / 1000);
  const claims: Record<string, unknown> = {
    iss: settings.clientId,
    sub: settings.clientId,
    aud: settings.tokenUrl,
    iat,
    jti: randomUUID(),
    ...(settings.claims ?? {}),
    exp: iat + ttl,
  };
  for (const name of ['iss', 'sub', 'aud'] as const) {
    const v = claims[name];
    if (typeof v !== 'string' || !v.trim()) {
      throw new ClientAssertionError(`the "${name}" claim is empty`);
    }
    const unresolved = findUnresolvedPlaceholders(v);
    if (unresolved.length > 0) {
      throw new ClientAssertionError(
        `the "${name}" claim is not set ({{${unresolved[0]}}} has no value)`,
      );
    }
  }

  const header: Record<string, string> = { alg: algorithm, typ: 'JWT' };
  if (settings.keyId) header.kid = settings.keyId;
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = sign(alg.hash, Buffer.from(signingInput), {
    key,
    ...(alg.pss
      ? { padding: 6 /* RSA_PKCS1_PSS_PADDING */, saltLength: 32 }
      : {}),
    ...(alg.keyType === 'ec' ? { dsaEncoding: 'ieee-p1363' as const } : {}),
  });
  return `${signingInput}.${b64url(signature)}`;
}

/** The two form fields a token request carries under private_key_jwt. */
export function clientAssertionParams(
  settings: ClientAssertionSettings,
  now?: number,
): { client_assertion_type: string; client_assertion: string } {
  return {
    client_assertion_type: CLIENT_ASSERTION_TYPE,
    client_assertion: signClientAssertion(settings, now),
  };
}

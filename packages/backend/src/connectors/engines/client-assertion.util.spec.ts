import { generateKeyPairSync, verify, createPublicKey } from 'crypto';
import {
  CLIENT_ASSERTION_TYPE,
  clientAssertionParams,
  clientAssertionSettingsFrom,
  parsePrivateKey,
  signClientAssertion,
} from './client-assertion.util';

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pkcs8Pem = rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const pkcs1Pem = rsa.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const ecPem = ec.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

function decode(jwt: string) {
  const [h, p, s] = jwt.split('.');
  return {
    header: JSON.parse(Buffer.from(h, 'base64url').toString()),
    payload: JSON.parse(Buffer.from(p, 'base64url').toString()),
    signingInput: `${h}.${p}`,
    signature: Buffer.from(s, 'base64url'),
  };
}

const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);

describe('client assertion (private_key_jwt)', () => {
  const base = {
    privateKey: pkcs8Pem,
    clientId: 'client-123',
    tokenUrl: 'https://idp.example.com/token',
  };

  it('signs an RS256 JWT the public key verifies, with RFC 7523 default claims', () => {
    const jwt = signClientAssertion(base, NOW);
    const { header, payload, signingInput, signature } = decode(jwt);
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(payload).toMatchObject({
      iss: 'client-123',
      sub: 'client-123',
      aud: 'https://idp.example.com/token',
      iat: NOW / 1000,
      exp: NOW / 1000 + 300,
    });
    expect(typeof payload.jti).toBe('string');
    expect(verify('sha256', Buffer.from(signingInput), rsa.publicKey, signature)).toBe(true);
  });

  it('signs a fresh assertion (new jti) every time', () => {
    expect(decode(signClientAssertion(base, NOW)).payload.jti).not.toBe(
      decode(signClientAssertion(base, NOW)).payload.jti,
    );
  });

  // Revolut Business: iss = the redirect URI's domain, aud = https://revolut.com
  // (developer.revolut.com, "Make your first API request", step 2).
  it('lets the adapter override claims, but exp always follows ttlSeconds', () => {
    const { payload } = decode(
      signClientAssertion(
        {
          ...base,
          ttlSeconds: 120,
          claims: { iss: 'cloud.anythingmcp.com', aud: 'https://revolut.com', exp: 1 },
        },
        NOW,
      ),
    );
    expect(payload.iss).toBe('cloud.anythingmcp.com');
    expect(payload.sub).toBe('client-123');
    expect(payload.aud).toBe('https://revolut.com');
    expect(payload.exp).toBe(NOW / 1000 + 120);
  });

  it('caps the lifetime at one hour', () => {
    const { payload } = decode(signClientAssertion({ ...base, ttlSeconds: 86400 * 365 }, NOW));
    expect(payload.exp - payload.iat).toBe(3600);
  });

  it('adds a kid header when a key id is configured', () => {
    expect(decode(signClientAssertion({ ...base, keyId: 'k1' }, NOW)).header.kid).toBe('k1');
  });

  it('signs ES256 in the JOSE (r||s) encoding', () => {
    const jwt = signClientAssertion({ ...base, privateKey: ecPem, algorithm: 'ES256' }, NOW);
    const { header, signingInput, signature } = decode(jwt);
    expect(header.alg).toBe('ES256');
    expect(signature).toHaveLength(64);
    expect(
      verify('sha256', Buffer.from(signingInput), { key: ec.publicKey, dsaEncoding: 'ieee-p1363' }, signature),
    ).toBe(true);
  });

  it('refuses an algorithm that does not match the key', () => {
    expect(() => signClientAssertion({ ...base, algorithm: 'ES256' }, NOW)).toThrow(
      /ES256 needs an EC key/,
    );
    expect(() => signClientAssertion({ ...base, algorithm: 'HS256' }, NOW)).toThrow(
      /unsupported algorithm/,
    );
  });

  it('names an unset claim variable instead of signing it', () => {
    expect(() =>
      signClientAssertion({ ...base, claims: { iss: '{{REVOLUT_REDIRECT_DOMAIN}}' } }, NOW),
    ).toThrow('the "iss" claim is not set ({{REVOLUT_REDIRECT_DOMAIN}} has no value)');
  });

  it('returns the two form fields of a token request', () => {
    const params = clientAssertionParams(base, NOW);
    expect(params.client_assertion_type).toBe(CLIENT_ASSERTION_TYPE);
    expect(params.client_assertion.split('.')).toHaveLength(3);
  });

  describe('parsePrivateKey', () => {
    const publicDer = createPublicKey(rsa.privateKey).export({ type: 'spki', format: 'der' });
    const same = (pem: string) =>
      createPublicKey(parsePrivateKey(pem)).export({ type: 'spki', format: 'der' }).equals(publicDer);

    it('reads PKCS#8 (OpenSSL 3 genrsa) and PKCS#1 (LibreSSL genrsa) keys', () => {
      expect(same(pkcs8Pem)).toBe(true);
      expect(same(pkcs1Pem)).toBe(true);
    });

    // Env vars are typed into single-line inputs; browsers drop the newlines.
    it('reads a key whose line breaks were stripped by a single-line input', () => {
      expect(same(pkcs8Pem.replace(/\r?\n/g, ''))).toBe(true);
      expect(same(pkcs1Pem.replace(/\r?\n/g, ' '))).toBe(true);
    });

    it('reads a key stored with literal \\n sequences', () => {
      expect(same(pkcs8Pem.replace(/\n/g, '\\n'))).toBe(true);
    });

    it('explains the common mistakes without echoing the value', () => {
      expect(() => parsePrivateKey('')).toThrow('no private key is configured');
      expect(() => parsePrivateKey('{{REVOLUT_PRIVATE_KEY}}')).toThrow(
        'the private key is not set ({{REVOLUT_PRIVATE_KEY}} has no value)',
      );
      expect(() => parsePrivateKey('not a key')).toThrow(/not a PEM key/);
      expect(() =>
        parsePrivateKey('-----BEGIN CERTIFICATE-----MIIB-----END CERTIFICATE-----'),
      ).toThrow(/public half/);
      expect(() =>
        parsePrivateKey('-----BEGIN ENCRYPTED PRIVATE KEY-----MIIB-----END ENCRYPTED PRIVATE KEY-----'),
      ).toThrow(/encrypted with a passphrase/);
      expect(() =>
        parsePrivateKey('-----BEGIN PRIVATE KEY-----c2VjcmV0-----END PRIVATE KEY-----'),
      ).toThrow('client assertion: the private key could not be read (damaged or incomplete PEM)');
    });
  });

  describe('clientAssertionSettingsFrom', () => {
    it('reads the nested clientAssertion block of an authConfig', () => {
      expect(
        clientAssertionSettingsFrom(
          {
            clientId: 'abc',
            clientAssertion: {
              privateKey: 'PEM',
              algorithm: 'RS256',
              ttlSeconds: '600',
              keyId: 'k',
              claims: { aud: 'https://revolut.com' },
            },
          },
          'https://b2b.revolut.com/api/1.0/auth/token',
        ),
      ).toEqual({
        privateKey: 'PEM',
        clientId: 'abc',
        tokenUrl: 'https://b2b.revolut.com/api/1.0/auth/token',
        algorithm: 'RS256',
        ttlSeconds: 600,
        keyId: 'k',
        claims: { aud: 'https://revolut.com' },
      });
    });

    it('tolerates a missing block (the signer then says what is missing)', () => {
      const settings = clientAssertionSettingsFrom({ clientId: 'abc' }, 'https://t');
      expect(settings.privateKey).toBe('');
      expect(() => signClientAssertion(settings)).toThrow('no private key is configured');
    });
  });
});

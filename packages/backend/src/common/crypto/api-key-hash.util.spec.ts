import { createHmac, hkdfSync } from 'node:crypto';
import { apiKeyLookupWhere, apiKeyPepper, apiKeySuffix, hashApiKey } from './api-key-hash.util';

const SECRET_A = 'unit-test-encryption-key-0123456789abcdef';
const SECRET_B = 'another-unit-test-encryption-key-9876543210';
const KEY = `mcp_${'0123456789abcdef'.repeat(4)}`;

describe('api-key-hash.util', () => {
  it('derives the pepper with HKDF-SHA256 from ENCRYPTION_KEY', () => {
    const expected = Buffer.from(
      hkdfSync('sha256', SECRET_A, Buffer.alloc(0), 'amcp:mcp-api-key:v1', 32),
    );
    expect(apiKeyPepper(SECRET_A).equals(expected)).toBe(true);
    // The pepper is never the encryption key itself.
    expect(apiKeyPepper(SECRET_A).toString('utf8')).not.toContain(SECRET_A);
  });

  it('hashes with HMAC-SHA256 keyed on the pepper, as 64 hex chars', () => {
    const pepper = apiKeyPepper(SECRET_A);
    const expected = createHmac('sha256', pepper).update(KEY).digest('hex');
    expect(hashApiKey(KEY, pepper)).toBe(expected);
    expect(hashApiKey(KEY, pepper)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable across calls and differs per key and per ENCRYPTION_KEY', () => {
    const a = apiKeyPepper(SECRET_A);
    expect(hashApiKey(KEY, a)).toBe(hashApiKey(KEY, apiKeyPepper(SECRET_A)));
    expect(hashApiKey(`${KEY}0`, a)).not.toBe(hashApiKey(KEY, a));
    expect(hashApiKey(KEY, apiKeyPepper(SECRET_B))).not.toBe(hashApiKey(KEY, a));
  });

  it('is not a plain SHA-256 of the key', () => {
    const plain = require('node:crypto').createHash('sha256').update(KEY).digest('hex');
    expect(hashApiKey(KEY, apiKeyPepper(SECRET_A))).not.toBe(plain);
  });

  it('refuses a missing or weak ENCRYPTION_KEY', () => {
    expect(() => apiKeyPepper('')).toThrow(/ENCRYPTION_KEY is not set/);
    expect(() => apiKeyPepper('short')).toThrow(/too short/);
  });

  it('keeps the last 8 characters as the suffix', () => {
    expect(apiKeySuffix(KEY)).toBe('89abcdef');
  });

  it('looks up by hash or, during the transition, by the plaintext column', () => {
    const pepper = apiKeyPepper(SECRET_A);
    expect(apiKeyLookupWhere(KEY, pepper)).toEqual({
      OR: [{ keyHash: hashApiKey(KEY, pepper) }, { key: KEY }],
    });
  });
});

import { encrypt, decrypt } from './encryption.util';

describe('Encryption Utility', () => {
  // Keys must be exactly 32 characters for AES-256
  const key = 'test-encryption-key-32-chars-ok!';

  it('should encrypt and decrypt a string', () => {
    const plaintext = 'my-secret-api-key';
    const encrypted = encrypt(plaintext, key);

    expect(encrypted).not.toBe(plaintext);
    expect(typeof encrypted).toBe('string');

    const decrypted = decrypt(encrypted, key);
    expect(decrypted).toBe(plaintext);
  });

  it('should produce different ciphertexts for the same input (random IV)', () => {
    const plaintext = 'same-input';
    const a = encrypt(plaintext, key);
    const b = encrypt(plaintext, key);

    expect(a).not.toBe(b);
    expect(decrypt(a, key)).toBe(plaintext);
    expect(decrypt(b, key)).toBe(plaintext);
  });

  it('should handle empty strings', () => {
    const encrypted = encrypt('', key);
    const decrypted = decrypt(encrypted, key);
    expect(decrypted).toBe('');
  });

  it('should handle special characters and unicode', () => {
    const plaintext = '{"apiKey":"sk-123","token":"eyJhbGciOiJ"}';
    const encrypted = encrypt(plaintext, key);
    const decrypted = decrypt(encrypted, key);
    expect(decrypted).toBe(plaintext);
  });

  it('should fail to decrypt with wrong key', () => {
    const encrypted = encrypt('secret', key);
    const wrongKey = 'different-key-exactly-32-chars!!';
    expect(() => decrypt(encrypted, wrongKey)).toThrow();
  });

  describe('additional authenticated data (AAD)', () => {
    // The encryption key is instance-wide, so without AAD a stored ciphertext
    // could be copied into another row — another organization's identity
    // provider, say — and would still decrypt happily.
    const aad = 'idp_client_secret:provider-1:org-1';

    it('round-trips when the AAD matches', () => {
      const encrypted = encrypt('client-secret', key, aad);
      expect(decrypt(encrypted, key, aad)).toBe('client-secret');
    });

    it('refuses to decrypt a ciphertext moved to another row', () => {
      const encrypted = encrypt('client-secret', key, aad);
      const otherRow = 'idp_client_secret:provider-1:org-2';
      expect(() => decrypt(encrypted, key, otherRow)).toThrow();
    });

    it('refuses to decrypt without the AAD it was bound to', () => {
      const encrypted = encrypt('client-secret', key, aad);
      expect(() => decrypt(encrypted, key)).toThrow();
    });

    it('stays compatible with data encrypted before AAD existed', () => {
      // Connector credentials were written without it and must keep working.
      const legacy = encrypt('legacy-value', key);
      expect(decrypt(legacy, key)).toBe('legacy-value');
    });
  });
});

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
});

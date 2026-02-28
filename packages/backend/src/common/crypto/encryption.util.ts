import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

/**
 * Encrypt sensitive data (API keys, credentials) using AES-256-GCM.
 * Returns: base64(iv + ciphertext + authTag)
 */
export function encrypt(plaintext: string, encryptionKey: string): string {
  const key = Buffer.from(encryptionKey, 'utf-8').subarray(0, 32);
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([iv, encrypted, tag]).toString('base64');
}

/**
 * Decrypt data encrypted with encrypt().
 */
export function decrypt(ciphertext: string, encryptionKey: string): string {
  const key = Buffer.from(encryptionKey, 'utf-8').subarray(0, 32);
  const data = Buffer.from(ciphertext, 'base64');

  const iv = data.subarray(0, IV_LENGTH);
  const tag = data.subarray(data.length - TAG_LENGTH);
  const encrypted = data.subarray(IV_LENGTH, data.length - TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  return decipher.update(encrypted) + decipher.final('utf8');
}

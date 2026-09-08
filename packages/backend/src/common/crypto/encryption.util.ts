import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

/**
 * Encrypt sensitive data (API keys, credentials) using AES-256-GCM.
 * Returns: base64(iv + ciphertext + authTag)
 *
 * `aad` is optional Additional Authenticated Data. It is not stored, and it is
 * not secret — it binds the ciphertext to its context, so a blob copied into a
 * different row (another provider, another organization) fails to decrypt
 * instead of silently succeeding. Callers that omit it keep the previous
 * behaviour and remain wire-compatible with data encrypted before it existed.
 */
export function encrypt(
  plaintext: string,
  encryptionKey: string,
  aad?: string,
): string {
  const key = Buffer.from(encryptionKey, 'utf-8').subarray(0, 32);
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv(ALGORITHM, key, iv);
  // `!== undefined`, not truthiness: an empty-string AAD must bind to the
  // empty string, not silently degrade to no AAD at all.
  if (aad !== undefined) cipher.setAAD(Buffer.from(aad, 'utf-8'));
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([iv, encrypted, tag]).toString('base64');
}

/**
 * Decrypt data encrypted with encrypt().
 *
 * `aad` must match what was passed at encryption time, or the authentication
 * tag check fails and this throws — which is the point: it is what stops a
 * ciphertext being moved between rows.
 */
export function decrypt(
  ciphertext: string,
  encryptionKey: string,
  aad?: string,
): string {
  const key = Buffer.from(encryptionKey, 'utf-8').subarray(0, 32);
  const data = Buffer.from(ciphertext, 'base64');

  const iv = data.subarray(0, IV_LENGTH);
  const tag = data.subarray(data.length - TAG_LENGTH);
  const encrypted = data.subarray(IV_LENGTH, data.length - TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  if (aad !== undefined) decipher.setAAD(Buffer.from(aad, 'utf-8'));
  decipher.setAuthTag(tag);

  return decipher.update(encrypted) + decipher.final('utf8');
}

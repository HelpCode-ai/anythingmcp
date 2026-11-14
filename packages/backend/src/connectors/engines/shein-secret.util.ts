import { createDecipheriv } from 'node:crypto';

/**
 * SHEIN Open Platform: decrypting a shop's `secretKey`.
 *
 * A seller authorizes an app on SHEIN's page; the app then exchanges the
 * `tempToken` of the redirect at `POST /open-api/auth/get-by-token` for the
 * shop's `openKeyId` and `secretKey`. That `secretKey` arrives encrypted with
 * the app's own secret and must be decrypted once before it can sign a call
 * ("Secretkey has not been decrypted" is the first cause SHEIN lists for a
 * refused signature).
 *
 * The scheme, from SHEIN's "Store Authorization Application Manual"
 * (open.sheincorp.com, section "Secret Key Decryption") and the open SDKs
 * sheinsight/open-sdk-js and open-sdk-java (`AesUtil.decrypt`):
 * AES-128-CBC with PKCS#7 padding; the key is the first 16 bytes of the
 * app's secret key as UTF-8 (padded with zero bytes when it is shorter); the
 * IV is the 16 bytes of the text `space-station-de`; the ciphertext is
 * Base64, the plaintext UTF-8.
 *
 * Pure and without I/O. Nothing calls it yet: it is the piece a SHEIN
 * authorization flow needs after `get-by-token`.
 */
const SHEIN_IV = Buffer.from('space-station-de', 'utf8');

export class SheinSecretError extends Error {
  constructor(message: string) {
    super(`SHEIN secret key: ${message}`);
    this.name = 'SheinSecretError';
  }
}

export function decryptSheinSecretKey(encryptedSecretKey: string, appSecretKey: string): string {
  if (typeof encryptedSecretKey !== 'string' || !encryptedSecretKey.trim()) {
    throw new SheinSecretError('the encrypted secretKey is empty');
  }
  if (typeof appSecretKey !== 'string' || !appSecretKey) {
    throw new SheinSecretError("the app's secret key is empty");
  }
  const ciphertext = Buffer.from(encryptedSecretKey.trim(), 'base64');
  // Base64 that does not round-trip, or bytes that are not whole AES blocks,
  // are not something SHEIN issued: say so instead of a cipher error.
  if (ciphertext.length === 0 || ciphertext.length % 16 !== 0) {
    throw new SheinSecretError('the encrypted secretKey is not valid: copy the whole value of get-by-token again');
  }
  const key = Buffer.alloc(16);
  Buffer.from(appSecretKey, 'utf8').copy(key, 0, 0, 16);
  try {
    const decipher = createDecipheriv('aes-128-cbc', key, SHEIN_IV);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // Never echo either value: both are credentials.
    throw new SheinSecretError(
      "it could not be decrypted with this app secret: check that the secret key is the one of the app the shop authorized",
    );
  }
}

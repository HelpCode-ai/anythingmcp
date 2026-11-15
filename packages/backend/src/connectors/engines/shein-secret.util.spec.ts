import { createCipheriv } from 'node:crypto';
import { decryptSheinSecretKey, SheinSecretError } from './shein-secret.util';

/**
 * Vectors from SHEIN's own documentation, "Store Authorization Application
 * Manual", section "Secret Key Decryption" (open.sheincorp.com, page
 * 2169474d-1d4a-41a9-b9fd-427f63f54a63): the C#, PHP and Python examples
 * each print an app secret key, a ciphertext and the plaintext. The open SDKs
 * (sheinsight/open-sdk-js, open-sdk-java) implement the same `AesUtil` but
 * their tests only encrypt and decrypt in a round trip, without fixed values.
 */
describe('decryptSheinSecretKey', () => {
  it("decrypts the secretKey of SHEIN's C# example", () => {
    expect(
      decryptSheinSecretKey(
        'Um6W8uVjabRyt5zJI3hw/38ke8dvUq1o6Vkk1f/Gzjt+sWGeUpYBIFTk7/xVHhJy',
        '698E4F20DFBA4B85B2291C2BCB7381C5',
      ),
    ).toBe('E547DCB619824189AD3A532546AE37F9');
  });

  it("decrypts the values of SHEIN's PHP and Python examples", () => {
    expect(decryptSheinSecretKey('IULL9EKxPobs/B+CED6flQ==', '0D8BD3F0AC9F12B0B6B6876527D0175F')).toBe('123456');
    expect(decryptSheinSecretKey('lr4JDSqQkRyZ2YAosX3ZRQ==', '14ABE7A4222647CB945DADC76740BA73')).toBe('Hello World');
  });

  it('uses the first 16 bytes of the app secret, zero-padded when it is shorter', () => {
    const encrypt = (plain: string, key: Buffer) => {
      const cipher = createCipheriv('aes-128-cbc', key, Buffer.from('space-station-de', 'utf8'));
      return Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]).toString('base64');
    };
    const long = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
    expect(decryptSheinSecretKey(encrypt('secret-1', Buffer.from(long.slice(0, 16), 'utf8')), long)).toBe('secret-1');
    const short = Buffer.alloc(16);
    short.write('short', 'utf8');
    expect(decryptSheinSecretKey(encrypt('secret-2', short), 'short')).toBe('secret-2');
    // Surrounding whitespace from a paste is ignored.
    expect(decryptSheinSecretKey(`  ${encrypt('secret-3', short)}\n`, 'short')).toBe('secret-3');
  });

  it('refuses empty or malformed input and a wrong app secret, without echoing either value', () => {
    expect(() => decryptSheinSecretKey('', 'k')).toThrow(SheinSecretError);
    expect(() => decryptSheinSecretKey('IULL9EKxPobs/B+CED6flQ==', '')).toThrow(/app's secret key is empty/);
    expect(() => decryptSheinSecretKey('not base64 blocks', 'k')).toThrow(/not valid/);
    const wrong = (() => {
      try {
        decryptSheinSecretKey('Um6W8uVjabRyt5zJI3hw/38ke8dvUq1o6Vkk1f/Gzjt+sWGeUpYBIFTk7/xVHhJy', 'WRONG-APP-SECRET-0000000000000000');
        return null;
      } catch (e) {
        return e as Error;
      }
    })();
    // A wrong key either fails the padding check or yields other text; when it
    // fails, the message names neither value.
    if (wrong) {
      expect(wrong).toBeInstanceOf(SheinSecretError);
      expect(wrong.message).not.toContain('Um6W8uVj');
      expect(wrong.message).not.toContain('WRONG-APP-SECRET');
    }
  });
});

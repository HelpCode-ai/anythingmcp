import { parseCredentialKey, userCredentialKey } from './credential-key.util';
import { connectorPageUrl } from './url.util';

describe('credential keys', () => {
  it('round-trips the key of a user credential', () => {
    const key = userCredentialKey('cmconnector1', 'cmuser1');
    expect(key).toBe('cmconnector1:user:cmuser1');
    expect(parseCredentialKey(key)).toEqual({ connectorId: 'cmconnector1', userId: 'cmuser1' });
  });

  it('reads a plain connector id as the connector credential', () => {
    expect(parseCredentialKey('cmconnector1')).toEqual({ connectorId: 'cmconnector1' });
  });

  it('gives two users of one connector different keys', () => {
    expect(userCredentialKey('c1', 'u1')).not.toBe(userCredentialKey('c1', 'u2'));
  });

  it('does not take a malformed key for a user credential', () => {
    expect(parseCredentialKey(':user:u1')).toEqual({ connectorId: ':user:u1' });
    expect(parseCredentialKey('c1:user:')).toEqual({ connectorId: 'c1:user:' });
  });

  describe('connectorPageUrl', () => {
    const before = process.env.FRONTEND_URL;
    beforeEach(() => {
      process.env.FRONTEND_URL = 'https://app.example.com';
    });
    afterAll(() => {
      process.env.FRONTEND_URL = before;
    });

    it("links a user credential key to the page where that user connects, a connector to its page", () => {
      expect(connectorPageUrl(userCredentialKey('c1', 'u1'))).toBe('https://app.example.com/auth/connect/c1');
      expect(connectorPageUrl('c1')).toBe('https://app.example.com/connectors/c1');
    });
  });
});

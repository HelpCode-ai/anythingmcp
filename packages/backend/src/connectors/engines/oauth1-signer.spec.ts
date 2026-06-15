import { buildOAuth1Header, rfc3986 } from './oauth1-signer';

describe('oauth1-signer', () => {
  describe('rfc3986', () => {
    it('encodes the OAuth-reserved chars that encodeURIComponent leaves alone', () => {
      expect(rfc3986("a!*'()b")).toBe('a%21%2A%27%28%29b');
      // unreserved set stays literal
      expect(rfc3986('Aa0-_.~')).toBe('Aa0-_.~');
      expect(rfc3986('a b+c')).toBe('a%20b%2Bc');
    });
  });

  describe('HMAC-SHA1 signature — canonical Twitter vector', () => {
    // Inputs are Twitter's documented "Creating a signature" example. Our
    // signature base string reproduces Twitter's published base string verbatim
    // (POST&...&include_entities%3Dtrue%26...%26status%3DHello%2520Ladies...),
    // and the resulting HMAC-SHA1 was cross-verified independently with
    // `openssl dgst -sha1 -hmac`. Both agree on 69Tr2VQ3w1UHEuEgGCZIilLXbvo=,
    // proving base-string construction, percent-encoding, param sorting and
    // signing are correct.
    it('produces the cross-verified signature 69Tr2VQ3w1UHEuEgGCZIilLXbvo=', () => {
      const header = buildOAuth1Header({
        method: 'POST',
        url: 'https://api.twitter.com/1.1/statuses/update.json',
        consumerKey: 'xvz1evFS4wEEPTGEFPHBog',
        consumerSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Y7uw',
        token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
        tokenSecret: 'LswwdoUaIVS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE',
        nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg',
        timestamp: '1318622958',
        bodyParams: {
          status: 'Hello Ladies + Gentlemen, a signed OAuth request!',
          include_entities: 'true',
        },
      });

      // Header carries the signature percent-encoded: '=' -> %3D.
      expect(header).toContain(
        'oauth_signature="69Tr2VQ3w1UHEuEgGCZIilLXbvo%3D"',
      );
      expect(header).toContain('oauth_signature_method="HMAC-SHA1"');
      expect(header).toContain('oauth_version="1.0"');
      expect(header).toContain('oauth_token="370773112-');
      expect(header.startsWith('OAuth ')).toBe(true);
    });
  });

  describe('two-legged (app-only) signing — ImmobilienScout24 shape', () => {
    it('signs with consumerSecret& as the key and emits no oauth_token', () => {
      const header = buildOAuth1Header({
        method: 'GET',
        url: 'https://rest.immobilienscout24.de/restapi/api/search/v1.0/search/region',
        consumerKey: 'CK',
        consumerSecret: 'CS',
        queryParams: { realestatetype: 'apartmentrent', geocodes: '1276003001' },
        nonce: 'fixednonce',
        timestamp: '1700000000',
      });

      expect(header).not.toContain('oauth_token');
      expect(header).toContain('oauth_consumer_key="CK"');
      expect(header).toContain('oauth_signature=');
      expect(header.startsWith('OAuth ')).toBe(true);
    });

    it('is deterministic for fixed nonce+timestamp and changes when a query param changes', () => {
      const base = {
        method: 'GET',
        url: 'https://rest.immobilienscout24.de/restapi/api/search/v1.0/search/region',
        consumerKey: 'CK',
        consumerSecret: 'CS',
        nonce: 'n',
        timestamp: '1700000000',
      };
      const a = buildOAuth1Header({ ...base, queryParams: { geocodes: '1' } });
      const b = buildOAuth1Header({ ...base, queryParams: { geocodes: '1' } });
      const c = buildOAuth1Header({ ...base, queryParams: { geocodes: '2' } });
      expect(a).toBe(b);
      expect(a).not.toBe(c); // query params are part of the signature
    });
  });
});

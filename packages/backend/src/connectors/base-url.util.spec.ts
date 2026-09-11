import { validateBaseUrl } from './base-url.util';

const cloud = { type: 'REST', requirePublicHost: true };
const selfHosted = { type: 'REST', requirePublicHost: false };

describe('validateBaseUrl', () => {
  describe('what production actually contained', () => {
    // Every value below is a real row from the cloud database. Each produced a
    // connector with no usable tools and no explanation to the user.
    it('rejects an API key pasted into the URL field', () => {
      expect(
        validateBaseUrl(
          'https://pk_56532023_AZFKELRKU7FWLDAE9W9X0I9M8KYVIC64',
          cloud,
        ),
      ).toMatch(/not a server address.*Authentication/s);
    });

    it('rejects a secret key pasted into the URL field', () => {
      expect(
        validateBaseUrl(
          'https://sk_b140c13c4b03ab6be9adee5f77899435a773138067e03db8f5d6017902b1be96',
          cloud,
        ),
      ).toBeTruthy();
    });

    it('rejects a bare single word', () => {
      expect(validateBaseUrl('https://Ahmad1', cloud)).toBeTruthy();
    });

    // Whether the UI prefixed https:// or not, the person pasted a credential.
    // Both paths must point them at the Authentication section.
    it('points an unprefixed credential at the Authentication section', () => {
      expect(
        validateBaseUrl('pk_56532023_AZFKELRKU7FWLDAE9W9X0I9M8KYVIC64', cloud),
      ).toMatch(/API key or token, put it under Authentication/);
    });

    it('does not cry credential over an ordinary typo', () => {
      expect(validateBaseUrl('htp:/oops', cloud)).not.toMatch(/API key/);
    });

    it('rejects a javascript: payload', () => {
      expect(
        validateBaseUrl(
          "javascript:changeMode('Update','d051917a3bff919971de904263d8e0e5',' ',' ','project')",
          cloud,
        ),
      ).toMatch(/not a supported scheme/);
    });

    it('rejects "test" as a database connection string', () => {
      expect(
        validateBaseUrl('test', { type: 'DATABASE', requirePublicHost: true }),
      ).toMatch(/not a database connection string/);
    });
  });

  describe('what must keep working', () => {
    it('accepts an ordinary API base URL', () => {
      expect(
        validateBaseUrl('https://api.example.com/v1', cloud),
      ).toBeNull();
    });

    it('accepts a real tenant host', () => {
      expect(
        validateBaseUrl('https://stryve.weclapp.com/webapp/api/v2', cloud),
      ).toBeNull();
    });

    // 20 connectors ship a placeholder resolved per call — Amazon SP-API,
    // Magento, Substack, Bitrix24. They are not literal URLs and must not be
    // parsed as such.
    it('leaves a fully templated URL alone', () => {
      expect(validateBaseUrl('{{SPAPI_ENDPOINT}}', cloud)).toBeNull();
    });

    it('leaves a partially templated URL alone', () => {
      expect(
        validateBaseUrl('{{MAGENTO_BASE_URL}}/rest/default/V1', cloud),
      ).toBeNull();
    });

    it('accepts the database connection strings in use', () => {
      const db = { type: 'DATABASE', requirePublicHost: true };
      expect(
        validateBaseUrl(
          'postgresql://user:pass@aws-0-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=no-verify',
          db,
        ),
      ).toBeNull();
      expect(
        validateBaseUrl('mysql://bz-spjk:pw@14.103.194.152:3306/bz-spjk', db),
      ).toBeNull();
    });

    it('accepts an IPv4 host', () => {
      expect(validateBaseUrl('http://78.24.216.122:8080/api', cloud)).toBeNull();
    });

    it('accepts localhost', () => {
      expect(validateBaseUrl('http://localhost:3000', cloud)).toBeNull();
    });
  });

  // A self-hosted instance reaches services by Docker network name; the cloud
  // has no internal network, so there a single label is always a mistake.
  describe('single-label hosts', () => {
    it('are refused on cloud', () => {
      expect(validateBaseUrl('http://weclapp:8080', cloud)).toBeTruthy();
    });

    it('are allowed when self-hosted', () => {
      expect(validateBaseUrl('http://weclapp:8080', selfHosted)).toBeNull();
    });
  });

  describe('basics', () => {
    it('requires a value', () => {
      expect(validateBaseUrl('   ', cloud)).toMatch(/required/);
      expect(validateBaseUrl(undefined as unknown as string, cloud)).toMatch(
        /required/,
      );
    });

    it('rejects something that is not a URL at all', () => {
      expect(validateBaseUrl('not a url', cloud)).toMatch(/not a valid URL/);
    });

    it('rejects ftp://', () => {
      expect(validateBaseUrl('ftp://files.example.com', cloud)).toMatch(
        /not a supported scheme/,
      );
    });

    it('truncates a long offending value instead of echoing all of it', () => {
      const problem = validateBaseUrl(`https://${'x'.repeat(200)}`, cloud);
      expect(problem!.length).toBeLessThan(260);
      expect(problem).toContain('…');
    });
  });
});

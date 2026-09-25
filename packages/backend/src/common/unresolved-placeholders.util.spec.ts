import {
  findUnresolvedPlaceholders,
  assertNoUnresolvedPlaceholders,
} from './unresolved-placeholders.util';

describe('findUnresolvedPlaceholders', () => {
  it('finds names in strings, nested objects and arrays, without duplicates', () => {
    expect(
      findUnresolvedPlaceholders({
        a: '{{ONE}}',
        b: { c: ['{{TWO}}', 'plain', '{{ONE}}'] },
        d: 42,
        e: null,
      }).sort(),
    ).toEqual(['ONE', 'TWO']);
  });

  it('finds both halves of a composed value', () => {
    // The Etsy header is exactly this shape.
    expect(
      findUnresolvedPlaceholders('{{ETSY_CLIENT_ID}}:{{ETSY_CLIENT_SECRET}}').sort(),
    ).toEqual(['ETSY_CLIENT_ID', 'ETSY_CLIENT_SECRET']);
  });

  it('says nothing about a fully resolved request', () => {
    expect(
      findUnresolvedPlaceholders({ token: 'abc123', url: 'https://api.example.com/v1' }),
    ).toEqual([]);
  });

  it('trims whitespace inside the braces', () => {
    expect(findUnresolvedPlaceholders('{{ SPACED }}')).toEqual(['SPACED']);
  });
});

describe('assertNoUnresolvedPlaceholders', () => {
  it('passes a request whose credentials are all filled in', () => {
    expect(() =>
      assertNoUnresolvedPlaceholders({
        baseUrl: 'https://openapi.etsy.com/v3/application',
        path: '/users/me',
        headers: { 'x-api-key': 'key:secret' },
        authConfig: { token: 'real-token' },
      }),
    ).not.toThrow();
  });

  it('refuses the call and names every missing variable', () => {
    // Reproduces the connector we caught in production: installed, never given
    // credentials, and Etsy answered with a complaint about the key format that
    // read exactly like the bug we had just fixed.
    expect(() =>
      assertNoUnresolvedPlaceholders(
        {
          baseUrl: 'https://openapi.etsy.com/v3/application',
          path: '/users/me',
          authConfig: {
            extraHeaders: { 'x-api-key': '{{ETSY_CLIENT_ID}}:{{ETSY_CLIENT_SECRET}}' },
          },
        },
        'the connector behind etsy_get_authenticated_user',
      ),
    ).toThrow(/ETSY_CLIENT_ID, ETSY_CLIENT_SECRET/);
  });

  it('names the subject so the error says which connector to open', () => {
    expect(() =>
      assertNoUnresolvedPlaceholders({ authConfig: { token: '{{X}}' } }, 'the "Acme" connector'),
    ).toThrow(/The "Acme" connector is missing a value for X/);
  });

  it('falls back to a generic subject', () => {
    expect(() =>
      assertNoUnresolvedPlaceholders({ authConfig: { token: '{{X}}' } }),
    ).toThrow(/This connector is missing/);
  });

  it('catches a base URL that is nothing but a placeholder (Substack)', () => {
    expect(() =>
      assertNoUnresolvedPlaceholders(
        { baseUrl: '{{SUBSTACK_PUBLICATION_URL}}', path: '/api/v1/posts' },
        'the connector behind substack_list_posts',
      ),
    ).toThrow(
      /^The connector behind substack_list_posts is missing a value for SUBSTACK_PUBLICATION_URL\. The request was not sent/,
    );
  });

  it('checks the query mapping too', () => {
    expect(() =>
      assertNoUnresolvedPlaceholders({
        baseUrl: 'https://api.example.com',
        path: '/items',
        queryParams: { q: '$q', tenant: '{{TENANT_ID}}' },
      }),
    ).toThrow(/missing a value for TENANT_ID/);
  });

  it('ignores the body, which may carry braces of its own', () => {
    // A request body is the caller's business and some upstreams take templates
    // verbatim; only auth, base URL, path and headers are credential-bearing.
    expect(() =>
      assertNoUnresolvedPlaceholders({
        baseUrl: 'https://api.example.com',
        path: '/render',
        authConfig: { token: 'real' },
      }),
    ).not.toThrow();
  });
});

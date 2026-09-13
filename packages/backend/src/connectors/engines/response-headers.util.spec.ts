import {
  describePagination,
  parseLinkHeader,
  pickExposedHeaders,
} from './response-headers.util';

describe('pickExposedHeaders', () => {
  it('returns only the asked-for headers, lower-cased, regardless of the wire casing', () => {
    const out = pickExposedHeaders(
      { 'X-RateLimit-Remaining': '39', Link: '<u>; rel="next"', 'set-cookie': 'nope' },
      ['link', 'x-ratelimit-remaining'],
    );
    expect(out).toEqual({ link: '<u>; rel="next"', 'x-ratelimit-remaining': '39' });
  });

  it('joins multi-valued headers and returns nothing when no tool asked', () => {
    expect(pickExposedHeaders({ link: ['a', 'b'] }, ['LINK'])).toEqual({ link: 'a, b' });
    expect(pickExposedHeaders({ link: 'x' }, undefined)).toEqual({});
    expect(pickExposedHeaders(undefined, ['link'])).toEqual({});
  });
});

describe('parseLinkHeader', () => {
  it('parses the GitHub / Sentry shape', () => {
    const rels = parseLinkHeader(
      '<https://api.example.com/issues/?cursor=100:1:0>; rel="previous"; results="false", ' +
        '<https://api.example.com/issues/?cursor=100:0:1>; rel="next"; results="true"',
    );
    expect(rels.next).toBe('https://api.example.com/issues/?cursor=100:0:1');
    expect(rels.previous).toBe('https://api.example.com/issues/?cursor=100:1:0');
  });

  it('accepts unquoted rel and a rel listing several tokens', () => {
    expect(parseLinkHeader('<https://x/a?page=3>; rel=next last')).toEqual({
      next: 'https://x/a?page=3',
      last: 'https://x/a?page=3',
    });
  });
});

describe('describePagination', () => {
  it('lifts the cursor out of the next link', () => {
    const p = describePagination({
      link: '<https://sentry.io/api/0/organizations/o/issues/?cursor=1568%3A0%3A0&query=is%3Aunresolved>; rel="next"',
    });
    expect(p).toEqual({
      nextUrl:
        'https://sentry.io/api/0/organizations/o/issues/?cursor=1568%3A0%3A0&query=is%3Aunresolved',
      nextCursor: '1568:0:0',
      cursorParam: 'cursor',
    });
  });

  it('recognises page numbers and keeps the previous page when announced', () => {
    const p = describePagination({
      link: '<https://x/repos?page=1>; rel="prev", <https://x/repos?page=3>; rel="next"',
    });
    expect(p?.nextCursor).toBe('3');
    expect(p?.cursorParam).toBe('page');
    expect(p?.prevUrl).toBe('https://x/repos?page=1');
  });

  it('is absent on the last page, and absent without a Link header', () => {
    expect(describePagination({ link: '<https://x/repos?page=1>; rel="first"' })).toBeUndefined();
    expect(describePagination({})).toBeUndefined();
  });

  it('still returns nextUrl when the URL has no recognisable cursor', () => {
    const p = describePagination({ link: '<https://x/feed/abc123>; rel="next"' });
    expect(p).toEqual({ nextUrl: 'https://x/feed/abc123' });
  });
});

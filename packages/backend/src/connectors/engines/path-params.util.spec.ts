import {
  assertSameOrigin,
  isAbsoluteHttpUrl,
  PathParameterError,
  substitutePathParams,
} from './path-params.util';

describe('path-params.util', () => {
  describe('substitutePathParams, values substituted as is', () => {
    it('substitutes each first placeholder and leaves unknown ones', () => {
      expect(substitutePathParams('/a/{x}/b/{y}/{z}', { x: '1', y: 'two/parts' }, false)).toBe(
        '/a/1/b/two/parts/{z}',
      );
    });

    it('substitutes in one pass: a value is not searched for placeholders', () => {
      expect(substitutePathParams('/a/{x}/{y}', { x: '{y}', y: 'b' }, false)).toBe('/a/{y}/b');
    });

    it('keeps $ patterns in a value literal', () => {
      expect(substitutePathParams('/i/{id}', { id: "a$&b$'c" }, false)).toBe("/i/a$&b$'c");
    });

    it.each([
      ['..', /"\." or "\.\." segment/],
      ['a/../b', /"\." or "\.\." segment/],
      ['a/%2E%2e/b', /"\." or "\.\." segment/],
      ['.', /"\." or "\.\." segment/],
      ['a?b=1', /"\?"/],
      ['a#b', /"#"/],
      ['a\\b', /"\\"/],
      ['https://x.example', /URL scheme/],
      ['a\u0000b', /control character/],
      ['a\nb', /control character/],
      ['a\u007fb', /control character/],
    ])('refuses %j in the middle of a template', (value, message) => {
      expect(() => substitutePathParams('/items/{id}/x', { id: value }, false)).toThrow(PathParameterError);
      expect(() => substitutePathParams('/items/{id}/x', { id: value }, false)).toThrow(message);
    });

    it('accepts "?" only in a placeholder that ends the template', () => {
      expect(substitutePathParams('/v2{next}', { next: '/returns?a=1&b=..' }, false)).toBe('/v2/returns?a=1&b=..');
      expect(() => substitutePathParams('/v2{next}/x', { next: '/r?a=1' }, false)).toThrow(/"\?"/);
      // The path part of such a value is still checked.
      expect(() => substitutePathParams('/v2{next}', { next: '/../admin?a=1' }, false)).toThrow(/segment/);
      expect(() => substitutePathParams('/v2{next}', { next: '/r?a=1#f' }, false)).toThrow(/"#"/);
    });

    it('accepts ordinary identifiers, dots inside names and encoded characters', () => {
      expect(substitutePathParams('/m/{m}/{f}', { m: 'crm.deal.list', f: 'a%2Fb..c' }, false)).toBe(
        '/m/crm.deal.list/a%2Fb..c',
      );
    });

    it('refuses a dot segment formed with template text', () => {
      expect(() => substitutePathParams('/a/.{x}/b', { x: '.' }, false)).toThrow(/segment/);
    });

    it('only refuses control characters and "#" in the template\'s own query string', () => {
      expect(
        substitutePathParams('/boards/{b}/items/{i}?tag_id={t}', { b: '1', i: '2', t: 'x/../y' }, false),
      ).toBe('/boards/1/items/2?tag_id=x/../y');
      expect(() => substitutePathParams('/boards?copy_from={b}', { b: 'a#b' }, false)).toThrow(/"#"/);
    });
  });

  describe('substitutePathParams, encoded values', () => {
    it('percent-encodes, so slashes and query characters stay in place', () => {
      expect(substitutePathParams('/s/{u}', { u: 'https://e.example/a?b#c' }, true)).toBe(
        '/s/https%3A%2F%2Fe.example%2Fa%3Fb%23c',
      );
    });

    it('refuses a value that is a whole dot segment', () => {
      expect(() => substitutePathParams('/s/{u}', { u: '..' }, true)).toThrow(PathParameterError);
      expect(() => substitutePathParams('/s/{u}', { u: '.' }, true)).toThrow(PathParameterError);
      expect(substitutePathParams('/s/{u}', { u: '...' }, true)).toBe('/s/...');
    });
  });

  describe('isAbsoluteHttpUrl', () => {
    it('recognises http(s) URLs only', () => {
      expect(isAbsoluteHttpUrl('https://a.example/x')).toBe(true);
      expect(isAbsoluteHttpUrl('HTTP://a.example')).toBe(true);
      expect(isAbsoluteHttpUrl('{next}')).toBe(false);
      expect(isAbsoluteHttpUrl('/x')).toBe(false);
      expect(isAbsoluteHttpUrl('//a.example/x')).toBe(false);
    });
  });

  describe('assertSameOrigin', () => {
    it('accepts the base origin and refuses another host, port or scheme', () => {
      expect(() => assertSameOrigin('https://api.example.com/v1/x', 'https://api.example.com/v1')).not.toThrow();
      for (const other of [
        'https://other.example.com/v1/x',
        'https://api.example.com:8443/v1/x',
        'http://api.example.com/v1/x',
      ]) {
        expect(() => assertSameOrigin(other, 'https://api.example.com/v1')).toThrow(/cannot change the host/);
      }
    });

    it('leaves a base URL that does not parse to the outbound URL check', () => {
      expect(() => assertSameOrigin('/x', '')).not.toThrow();
    });
  });
});

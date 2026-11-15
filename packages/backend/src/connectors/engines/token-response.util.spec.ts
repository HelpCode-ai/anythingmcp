import {
  describeMissingTokenFields,
  tokenFieldsAt,
  tokenResponsePathOf,
} from './token-response.util';

describe('authConfig.tokenResponsePath helpers', () => {
  it('reads the path as set, and treats a missing, blank or non-string value as unset', () => {
    expect(tokenResponsePathOf('data')).toBe('data');
    expect(tokenResponsePathOf(' result.token ')).toBe('result.token');
    for (const unset of [undefined, null, '', '   ', 0, true, ['data'], { path: 'data' }]) {
      expect(tokenResponsePathOf(unset)).toBeUndefined();
    }
  });

  it('returns the object at a dotted path', () => {
    const body = { code: 0, data: { access_token: 'at' }, result: { token: { access_token: 'deep' } } };
    expect(tokenFieldsAt(body, 'data')).toEqual({ access_token: 'at' });
    expect(tokenFieldsAt(body, 'result.token')).toEqual({ access_token: 'deep' });
  });

  it('finds nothing where the answer has no object', () => {
    for (const body of [undefined, null, '', 'a page of HTML', 7, [], { data: null }, { data: 'at' }, { data: ['at'] }, { other: {} }]) {
      expect(tokenFieldsAt(body, 'data')).toBeUndefined();
    }
    expect(tokenFieldsAt({ data: { access_token: 'at' } }, 'data.token')).toBeUndefined();
    // Inherited properties are not part of the answer.
    expect(tokenFieldsAt({}, 'constructor')).toBeUndefined();
    expect(tokenFieldsAt({}, '__proto__')).toBeUndefined();
  });

  it("quotes the provider's code and message, and nothing else of the answer", () => {
    expect(describeMissingTokenFields({ code: 1001, message: 'Invalid authorization code' }, 'data')).toBe(
      'the token answer has no object at "data" (authConfig.tokenResponsePath); the provider answered: code 1001: Invalid authorization code',
    );
    expect(describeMissingTokenFields({ code: 'E_AUTH' }, 'data')).toContain('the provider answered: code E_AUTH');
    expect(describeMissingTokenFields({ message: 'no such app' }, 'data')).toContain('the provider answered: no such app');

    const leaky = describeMissingTokenFields(
      { code: 0, message: '', access_token: 'top-level-token', refresh_token: 'top-level-refresh', data: 'not-an-object-token' },
      'data',
    );
    expect(leaky).toBe('the token answer has no object at "data" (authConfig.tokenResponsePath); the provider answered: code 0');
    expect(leaky).not.toMatch(/top-level|not-an-object/);
  });

  it('says only where it looked when the answer is not JSON or names no reason', () => {
    for (const body of [undefined, null, '<html>Bad gateway</html>', [], {}, { code: {}, message: 42 }]) {
      expect(describeMissingTokenFields(body, 'data')).toBe(
        'the token answer has no object at "data" (authConfig.tokenResponsePath)',
      );
    }
  });

  it('cuts a long message short', () => {
    const said = describeMissingTokenFields({ message: 'x'.repeat(500) }, 'data');
    expect(said.length).toBeLessThan(260);
  });
});

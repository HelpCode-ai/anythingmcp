import { deriveErrorHint, hostFromAxiosConfig } from './error-hints';

describe('deriveErrorHint', () => {
  it('says nothing for an ordinary failure', () => {
    expect(
      deriveErrorHint({ host: 'api.example.com', status: 500, body: { message: 'boom' } }),
    ).toBeUndefined();
  });

  describe('weclapp', () => {
    it('explains unknown properties instead of letting the model guess spellings', () => {
      const hint = deriveErrorHint({
        host: 'purora.weclapp.com',
        status: 400,
        body: { detail: 'unknown property: orderItems.articleNumber', status: 400 },
      });
      expect(hint).toMatch(/fetch ONE record/);
      expect(hint).toMatch(/orderItems/);
    });

    it('treats "unexpected filter property" the same way', () => {
      expect(
        deriveErrorHint({ host: 'x.weclapp.com', body: 'unexpected filter property' }),
      ).toMatch(/fetch ONE record/);
    });

    it('teaches the expression grammar when weclapp cannot parse the filter', () => {
      const hint = deriveErrorHint({
        host: 'purora.weclapp.com',
        status: 400,
        body: { detail: 'Expression contains errors' },
      });
      expect(hint).toMatch(/~ "%pattern%"/);
      expect(hint).toMatch(/like\/ilike do not exist/);
    });

    it('applies to hand-built tools on the same host, not only catalog ones', () => {
      expect(
        deriveErrorHint({ host: 'tenant.weclapp.com', body: 'unknown property: x' }),
      ).toBeDefined();
    });

    it('does not fire for another vendor that happens to say "unknown property"', () => {
      expect(
        deriveErrorHint({ host: 'api.other.com', body: 'unknown property: x' }),
      ).toBeUndefined();
    });
  });

  describe('login refused from a new country', () => {
    it('tells the model to hand over to the user, regardless of host', () => {
      const hint = deriveErrorHint({
        message: 'LOGIN_TOKEN: the service refused the login — authenticate_from_new_country',
      });
      expect(hint).toMatch(/confirm the login/);
      expect(hint).toMatch(/cannot be fixed by retrying/);
    });
  });
});

describe('hostFromAxiosConfig', () => {
  it('reads an absolute url', () => {
    expect(hostFromAxiosConfig({ url: 'https://a.weclapp.com/webapp/api/v2/article' })).toBe('a.weclapp.com');
  });

  it('combines a relative url with the baseURL', () => {
    expect(hostFromAxiosConfig({ baseURL: 'https://b.weclapp.com/webapp/api/v2', url: '/article' })).toBe('b.weclapp.com');
  });

  it('is undefined without a config', () => {
    expect(hostFromAxiosConfig(undefined)).toBeUndefined();
  });
});

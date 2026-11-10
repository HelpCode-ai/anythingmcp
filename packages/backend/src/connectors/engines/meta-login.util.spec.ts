import {
  buildMetaLoginUrl,
  cleanMetaCode,
  metaLoginAppOf,
  metaLoginFlavourOf,
  metaLoginFlavourOfSlug,
  metaLoginNeedsAuthorization,
  metaLoginPlatformApp,
  metaLoginScopes,
} from './meta-login.util';
import { getAdapter } from '../../adapters/catalog';

describe('meta-login.util', () => {
  it('maps the two Instagram adapters to their login', () => {
    expect(metaLoginFlavourOfSlug('instagram')).toBe('facebook');
    expect(metaLoginFlavourOfSlug('instagram-login')).toBe('instagram');
    expect(metaLoginFlavourOfSlug('facebook-pages')).toBeUndefined();
    expect(metaLoginFlavourOfSlug(undefined)).toBeUndefined();
    expect(metaLoginFlavourOf({ config: { adapterSlug: 'instagram-login' } })).toBe('instagram');
    expect(metaLoginFlavourOf({ config: null })).toBeUndefined();
  });

  it("asks for the permissions each adapter's tools use", () => {
    expect(metaLoginScopes('facebook')).toEqual(
      expect.arrayContaining(['instagram_basic', 'instagram_manage_insights', 'instagram_manage_comments', 'pages_show_list']),
    );
    expect(metaLoginScopes('instagram')).toEqual([
      'instagram_business_basic',
      'instagram_business_manage_insights',
      'instagram_business_manage_comments',
      'instagram_business_content_publish',
      'instagram_business_manage_messages',
    ]);
  });

  it('builds the Facebook dialog with the onboarding extras, and the Instagram one', () => {
    const fb = new URL(buildMetaLoginUrl('facebook', '111', 'https://cloud.anythingmcp.com/api/meta/callback', 'st'));
    expect(fb.origin + fb.pathname).toBe('https://www.facebook.com/v25.0/dialog/oauth');
    expect(Object.fromEntries(fb.searchParams)).toMatchObject({
      client_id: '111',
      redirect_uri: 'https://cloud.anythingmcp.com/api/meta/callback',
      response_type: 'code',
      state: 'st',
      extras: '{"setup":{"channel":"IG_API_ONBOARDING"}}',
    });
    expect(fb.searchParams.get('scope')!.split(',')).toEqual([...metaLoginScopes('facebook')]);

    const ig = new URL(buildMetaLoginUrl('instagram', '222', 'https://x.test/api/meta/callback', 'st2'));
    expect(ig.origin + ig.pathname).toBe('https://www.instagram.com/oauth/authorize');
    expect(Object.fromEntries(ig.searchParams)).toMatchObject({ client_id: '222', response_type: 'code', state: 'st2' });
    expect(ig.searchParams.get('extras')).toBeNull();
  });

  it('strips the #_ Instagram appends to the code', () => {
    expect(cleanMetaCode('AQBx-abc#_')).toBe('AQBx-abc');
    expect(cleanMetaCode(' AQBx-abc ')).toBe('AQBx-abc');
  });

  describe('which app', () => {
    const server = { META_PLATFORM_APP_ID: '900', META_PLATFORM_APP_SECRET: 's-900' };

    it("prefers the connector's own app, else the server's", () => {
      expect(metaLoginAppOf('facebook', { META_APP_ID: '1', META_APP_SECRET: 's1' }, server)).toEqual({
        app: { appId: '1', appSecret: 's1' },
        usesPlatformApp: false,
        missing: [],
      });
      expect(metaLoginAppOf('facebook', {}, server)).toEqual({
        app: { appId: '900', appSecret: 's-900' },
        usesPlatformApp: true,
        missing: [],
      });
      // Placeholders count as empty.
      expect(metaLoginAppOf('facebook', { META_APP_ID: '{{META_APP_ID}}' }, server).usesPlatformApp).toBe(true);
    });

    it('never mixes half an own app with the server app, and names what is missing', () => {
      expect(metaLoginAppOf('facebook', { META_APP_ID: '1' }, server)).toEqual({
        usesPlatformApp: false,
        missing: ['META_APP_SECRET'],
      });
      expect(metaLoginAppOf('instagram', {}, {})).toEqual({
        usesPlatformApp: false,
        missing: ['INSTAGRAM_APP_ID', 'INSTAGRAM_APP_SECRET'],
      });
    });

    it('keeps the two server apps apart', () => {
      expect(metaLoginPlatformApp('instagram', server)).toBeUndefined();
      expect(
        metaLoginPlatformApp('instagram', { INSTAGRAM_PLATFORM_APP_ID: '7', INSTAGRAM_PLATFORM_APP_SECRET: 's7' }),
      ).toEqual({ appId: '7', appSecret: 's7' });
      expect(metaLoginPlatformApp('facebook', { META_PLATFORM_APP_ID: '9' })).toBeUndefined();
    });
  });

  it('says a Meta login connector waits for its token until one is stored', () => {
    expect(metaLoginNeedsAuthorization('instagram', {})).toBe(true);
    expect(metaLoginNeedsAuthorization('instagram', { INSTAGRAM_ACCESS_TOKEN: '{{INSTAGRAM_ACCESS_TOKEN}}' })).toBe(true);
    expect(metaLoginNeedsAuthorization('instagram-login', { INSTAGRAM_ACCESS_TOKEN: 'IGAAtoken' })).toBe(false);
    expect(metaLoginNeedsAuthorization('github', {})).toBe(false);
  });

  it('matches the variables the catalog adapters declare', () => {
    for (const [slug, own] of [
      ['instagram', ['META_APP_ID', 'META_APP_SECRET']],
      ['instagram-login', ['INSTAGRAM_APP_ID', 'INSTAGRAM_APP_SECRET']],
    ] as const) {
      const adapter = getAdapter(slug)!;
      expect(adapter.requiredEnvVars).toEqual(expect.arrayContaining(['INSTAGRAM_ACCESS_TOKEN', 'INSTAGRAM_ACCOUNT_ID']));
      expect(adapter.optionalEnvVars).toEqual(expect.arrayContaining([...own]));
      expect(adapter.connector.authType).toBe('BEARER_TOKEN');
    }
  });
});

import { getAdapter, listAdapters } from './catalog';
import { computeAdapterVersion } from './catalog-fingerprint';
import { setupEffort } from './setup-guide';

describe('setupEffort', () => {
  const rest = { connector: { name: 'x', type: 'REST', baseUrl: 'https://api.test', authType: 'API_KEY' } } as any;

  it("uses the guide's own estimate", () => {
    expect(setupEffort(getAdapter('etsy')!)).toEqual({ effort: 'own_app', minutes: 10 });
    expect(setupEffort(getAdapter('telegram-bot')!)).toEqual({ effort: 'api_key', minutes: 2 });
  });

  it('derives one from how the adapter signs in', () => {
    expect(setupEffort({ ...rest, requiredEnvVars: [] })).toEqual({ effort: 'none', minutes: 0 });
    expect(setupEffort({ ...rest, requiredEnvVars: ['X_API_KEY'] })).toEqual({ effort: 'api_key', minutes: 3 });
  });

  it('tells an own app from a sign-in only for browser OAuth', () => {
    const google = getAdapter('google-search-console')!;
    expect(google.setupGuide).toBeUndefined();
    expect(setupEffort(google)).toEqual({ effort: 'own_app', minutes: 10 });
  });
});

describe('setupGuide in the catalog', () => {
  it('stays out of the listing, which only carries the badge', () => {
    const etsy = listAdapters().find((a) => a.slug === 'etsy')!;
    expect(etsy.setupGuide).toBeUndefined();
  });

  it('does not change the version stamped on installed connectors', () => {
    const etsy = getAdapter('etsy')!;
    const { setupGuide: _guide, ...withoutGuide } = etsy;
    expect(computeAdapterVersion(withoutGuide as any)).toBe(computeAdapterVersion(etsy));
  });

  it('follows Etsy: keys saved while the app is pending, the wait, then the callback URL and the sign-in', () => {
    const steps = getAdapter('etsy')!.setupGuide!.steps;
    expect(steps.map((s) => s.id)).toEqual(['create-app', 'keys', 'approval', 'callback', 'sign-in']);
    // Etsy shows the keys before it approves the app: they are asked for, and kept, first.
    expect(steps[1]).toMatchObject({ fields: ['ETSY_CLIENT_ID', 'ETSY_CLIENT_SECRET'], saveAndCheck: true });
    expect(steps[2].waitForProvider).toBe(true);
    // The app's page, where the callback URL goes, opens only once Etsy approved it.
    expect(steps[3].values).toEqual([{ label: 'Callback URL', value: '{{redirectUri}}' }]);
    expect(steps[4].fields).toBeUndefined();
  });
});

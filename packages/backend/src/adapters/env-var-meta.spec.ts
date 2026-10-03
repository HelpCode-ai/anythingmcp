import { getAdapter, listAdapters } from './catalog';
import { describeAdapterEnvVars, labelFromName, setupKind } from './env-var-meta';

const byName = (slug: string) =>
  Object.fromEntries(describeAdapterEnvVars(getAdapter(slug)!).map((d) => [d.name, d]));

describe('describeAdapterEnvVars', () => {
  it('derives a label without the adapter prefix', () => {
    expect(labelFromName('ETSY_CLIENT_ID', 'etsy')).toBe('Client ID');
    expect(labelFromName('WECLAPP_API_TOKEN', 'weclapp')).toBe('API Token');
    expect(labelFromName('SAP_HANA_HOST', 'sap-s4hana-hana')).toBe('HANA Host');
  });

  it('marks a variable used in the address as an address, and keys as secret', () => {
    const lexware = byName('lexware-office');
    expect(lexware.LEXWARE_API_KEY).toMatchObject({ kind: 'credential', secret: true, required: true });
    const weclapp = byName('weclapp');
    expect(weclapp.WECLAPP_TENANT).toMatchObject({ kind: 'address', secret: false, pattern: '^[A-Za-z0-9-]+$' });
  });

  it('lets the adapter correct what the name suggests', () => {
    // The bot token sits in the URL path, but it is a credential.
    expect(byName('telegram-bot').TELEGRAM_BOT_TOKEN).toMatchObject({ kind: 'credential', secret: true, label: 'Bot token' });
    expect(byName('sendcloud').SENDCLOUD_PUBLIC_KEY.secret).toBe(false);
  });

  it('folds away the token an authorization fills in', () => {
    const etsy = byName('etsy');
    expect(etsy.ETSY_REFRESH_TOKEN).toMatchObject({ advanced: true, required: false });
    expect(etsy.ETSY_CLIENT_ID.advanced).toBeUndefined();
  });

  it('describes every variable of every adapter without throwing', () => {
    for (const meta of listAdapters()) {
      const adapter = getAdapter(meta.slug)!;
      const described = describeAdapterEnvVars(adapter);
      expect(described.map((d) => d.name).sort()).toEqual(
        [...new Set([...adapter.requiredEnvVars, ...(adapter.optionalEnvVars ?? [])])].sort(),
      );
      for (const d of described) expect(d.label.length).toBeGreaterThan(0);
    }
  });
});

describe('setupKind', () => {
  it('tells keyless, credential and browser-authorization adapters apart', () => {
    expect(setupKind(getAdapter('openplz')!)).toBe('none');
    expect(setupKind(getAdapter('lexware-office')!)).toBe('credentials');
    expect(setupKind(getAdapter('etsy')!)).toBe('oauth_browser');
  });
});

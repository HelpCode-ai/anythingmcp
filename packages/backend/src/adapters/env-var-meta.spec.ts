import { getAdapter, listAdapters } from './catalog';
import {
  carriedSetupValues,
  describeAdapterEnvVars,
  describeEnvVarOptions,
  envVarOptions,
  labelFromName,
  setupKind,
} from './env-var-meta';

describe('carriedSetupValues', () => {
  it('carries the Odoo address and database to the JSON-RPC setup, never the key', () => {
    const out = carriedSetupValues(getAdapter('odoo')!, getAdapter('odoo-jsonrpc')!, {
      ODOO_URL: 'https://acme.odoo.com',
      ODOO_DB: ' acme ',
      ODOO_API_KEY: 'a3f9c27e18d04b5f9e6a7c1d2b3e4f5a6b7c8d9e',
    });
    expect(out).toEqual({ ODOO_URL: 'https://acme.odoo.com', ODOO_DB: 'acme' });
  });

  it('skips empty values, values still a {{VARIABLE}}, and names the target does not take', () => {
    expect(
      carriedSetupValues(getAdapter('odoo')!, getAdapter('odoo-jsonrpc')!, {
        ODOO_URL: '{{ODOO_URL}}',
        ODOO_DB: '',
        OTHER: 'x',
      }),
    ).toEqual({});
    expect(carriedSetupValues(getAdapter('odoo')!, getAdapter('odoo-jsonrpc')!, null)).toEqual({});
  });
});

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

describe('describeAdapterEnvVars — a fixed list of choices (envVarMeta.options)', () => {
  const countries = [
    { value: 'https://fr.market.example.test', label: 'France' },
    { value: 'https://es.market.example.test', label: 'Spain' },
  ];
  const market = (meta: Record<string, unknown>) =>
    ({
      slug: 'acme-market',
      connector: { type: 'REST', authType: 'API_KEY', baseUrl: '{{ACME_MARKET_URL}}/api' },
      requiredEnvVars: ['ACME_MARKET_URL', 'ACME_MARKET_API_KEY'],
      optionalEnvVars: ['ACME_MARKET_LOCALE'],
      envVarMeta: { ACME_MARKET_URL: { label: 'Country', ...meta } },
    }) as unknown as Parameters<typeof describeAdapterEnvVars>[0];
  const described = (meta: Record<string, unknown>) =>
    Object.fromEntries(describeAdapterEnvVars(market(meta)).map((d) => [d.name, d]));

  it('carries the choices on the descriptor, next to what the name gives', () => {
    const out = described({ options: countries, help: 'The country you sell in.' });
    expect(out.ACME_MARKET_URL).toEqual({
      name: 'ACME_MARKET_URL',
      required: true,
      label: 'Country',
      kind: 'address',
      secret: false,
      help: 'The country you sell in.',
      options: countries,
    });
    // A copy: nothing downstream can change the catalog entry.
    expect(out.ACME_MARKET_URL.options).not.toBe(countries);
  });

  it('adds nothing to a variable without choices', () => {
    const out = described({ options: countries });
    expect(out.ACME_MARKET_API_KEY).toEqual({
      name: 'ACME_MARKET_API_KEY',
      required: true,
      label: 'Market API Key',
      kind: 'credential',
      secret: true,
    });
    expect('options' in out.ACME_MARKET_LOCALE).toBe(false);
    expect('options' in described({}).ACME_MARKET_URL).toBe(false);
  });

  it('leaves out entries that are not a value and a label, and the field when none is left', () => {
    const out = described({
      options: [countries[0], null, 'es', { value: '', label: 'Empty' }, { value: 'x' }, { value: 7, label: 'Seven' }, { ...countries[0], label: 'Again' }, countries[1]],
    });
    expect(out.ACME_MARKET_URL.options).toEqual(countries);
    for (const options of ['fr,es', {}, [], [{ label: 'No value' }]]) {
      expect('options' in described({ options }).ACME_MARKET_URL).toBe(false);
    }
  });

  it('reads the choices of a meta entry, and names them in a sentence', () => {
    expect(envVarOptions(undefined)).toBeUndefined();
    expect(envVarOptions({})).toBeUndefined();
    expect(envVarOptions({ options: countries })).toEqual(countries);
    expect(describeEnvVarOptions([...countries, { value: 'eu', label: 'eu' }])).toBe(
      'France (https://fr.market.example.test), Spain (https://es.market.example.test), eu',
    );
  });
});

describe('setupKind', () => {
  it('tells keyless, credential and browser-authorization adapters apart', () => {
    expect(setupKind(getAdapter('openplz')!)).toBe('none');
    expect(setupKind(getAdapter('lexware-office')!)).toBe('credentials');
    expect(setupKind(getAdapter('etsy')!)).toBe('oauth_browser');
  });

  it('never calls a marketplace shop that is authorized on the setup page keyless', () => {
    // TikTok Shop asks for nothing on a server with its own app, but the shop still has to be authorized.
    expect(getAdapter('tiktok-shop')!.requiredEnvVars).toEqual([]);
    expect(setupKind(getAdapter('tiktok-shop')!)).toBe('credentials');
    expect(setupKind(getAdapter('shopee')!)).toBe('credentials');
  });
});

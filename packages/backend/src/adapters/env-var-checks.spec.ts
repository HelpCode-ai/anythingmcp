import { checkAdapterEnvValues, isRepeatedPaste, normalizeAdapterEnvValues, placeholderReason } from './env-var-checks';
import { getAdapter } from './catalog';
import { normalizeAddressVariables } from '../common/base-url-variable.util';

/** What install and the variable editors do before checking: the adapter's clean-ups, then the address ones. */
const prepare = (slug: string, values: Record<string, string>) => {
  const a = getAdapter(slug)!;
  return normalizeAddressVariables(a.connector.baseUrl, normalizeAdapterEnvValues(slug, values), a.connector.type, {
    singleLabel: true,
  });
};

describe('normalisation before the checks (shapes working connectors were saved with)', () => {
  it('telegram-bot: strips the whitespace a copied bot token carries', () => {
    // Built from parts so no token-shaped literal sits in the source (secret scanners flag those).
    const secret = ['FakeTokenForSpecs', 'OnlyNotARealBotKey'].join('');
    const values = prepare('telegram-bot', { TELEGRAM_BOT_TOKEN: `123456789: ${secret.slice(0, 17)} ${secret.slice(17)}` });
    expect(values.TELEGRAM_BOT_TOKEN).toBe(`123456789:${secret}`);
    expect(checkAdapterEnvValues(getAdapter('telegram-bot')!, values)).toEqual({});
  });

  it('weclapp: keeps the tenant of a whole host pasted into WECLAPP_TENANT', () => {
    for (const pasted of ['acme.weclapp.com', 'https://acme.weclapp.com/', 'https://acme.weclapp.com/webapp/api/v2']) {
      const values = prepare('weclapp', { WECLAPP_TENANT: pasted, WECLAPP_API_TOKEN: 'b1a2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d' });
      expect(values.WECLAPP_TENANT).toBe('acme');
      expect(checkAdapterEnvValues(getAdapter('weclapp')!, values)).toEqual({});
    }
  });

  it('bitrix24: cuts a method name and query copied after /rest/<id>/<code>/', () => {
    const base = 'https://acme.bitrix24.de/rest/12/abc123def456ghi7/';
    for (const pasted of [base, base.slice(0, -1), `${base}crm.deal.list`, `${base}crm.deal.list.json?ID=4`, `${base}profile/`]) {
      const values = prepare('bitrix24', { BITRIX24_WEBHOOK_URL: pasted });
      expect(values.BITRIX24_WEBHOOK_URL).toBe(base);
      expect(checkAdapterEnvValues(getAdapter('bitrix24')!, values)).toEqual({});
    }
  });

  it('bitrix24: any portal domain, but a bare portal address is still refused (the tools need the webhook path)', () => {
    for (const host of ['acme.bitrix24.ru', 'acme.bitrix24.eu', 'crm.acme-gmbh.de']) {
      expect(checkAdapterEnvValues(getAdapter('bitrix24')!, prepare('bitrix24', { BITRIX24_WEBHOOK_URL: `https://${host}/rest/1/abcdef0123456789/` }))).toEqual({});
    }
    const bare = checkAdapterEnvValues(getAdapter('bitrix24')!, prepare('bitrix24', { BITRIX24_WEBHOOK_URL: 'https://acme.bitrix24.com/' }));
    expect(bare.BITRIX24_WEBHOOK_URL).toMatch(/Inbound webhook/);
  });

  it('digisac: accepts an account on .digisac.io', () => {
    expect(
      checkAdapterEnvValues(getAdapter('digisac')!, { DIGISAC_URL: 'https://empresa.digisac.io' }, ['DIGISAC_URL']),
    ).toEqual({});
  });

  it('substack: still refuses a profile link, saying a profile is not a publication', () => {
    const fields = checkAdapterEnvValues(getAdapter('substack')!, prepare('substack', { SUBSTACK_PUBLICATION_URL: 'https://substack.com/@writer?utm_source=x' }));
    expect(fields.SUBSTACK_PUBLICATION_URL).toMatch(/is a person, not a publication/);
  });

  it('leaves other adapters and other variables alone', () => {
    const values = { ODOO_URL: ' https://acme.odoo.com ', X: 'a b' };
    expect(normalizeAdapterEnvValues('odoo', values)).toBe(values);
    expect(normalizeAdapterEnvValues('telegram-bot', { OTHER: 'a b' })).toEqual({ OTHER: 'a b' });
  });
});

const adapter = (slug: string) => {
  const a = getAdapter(slug);
  if (!a) throw new Error(`no adapter ${slug}`);
  return a;
};

describe('placeholderReason', () => {
  it.each(['host', 'HOSTNAME', 'server', 'your-host', 'yourdomain', 'example.com', 'https://example.com', 'https://www.example.com/', 'https://yourcompany.odoo.com', 'TODO', '<your-host>', 'xxx'])(
    'refuses the address %s',
    (value) => {
      expect(placeholderReason(value, 'address')).toBeDefined();
    },
  );

  it.each(['your-api-key', 'YOUR_TOKEN', 'PASTE_KEY_HERE', 'your_api_key_here', '<api key>', 'changeme', 'TODO', '...'])(
    'refuses the credential %s',
    (value) => {
      expect(placeholderReason(value, 'credential')).toBeDefined();
    },
  );

  it.each([
    'localhost',
    'erp',
    'sqlserver01',
    'db.internal',
    '192.168.1.20',
    'https://shop.example.com',
    'https://acme.odoo.com',
    'mycompany.odoo.com',
    'https://hostname-01.acme.de',
    'mysql.host.example.net',
  ])('accepts the real-looking address %s', (value) => {
    expect(placeholderReason(value, 'address')).toBeUndefined();
  });

  it.each(['sk-proj-abc123', '1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d', 'hostkey', 'mykey123', 'tokenhere1'])(
    'accepts the real-looking credential %s',
    (value) => {
      expect(placeholderReason(value, 'credential')).toBeUndefined();
    },
  );
});

describe('isRepeatedPaste', () => {
  const key = 'a3f9c27e18d04b5f9e6a7c1d2b3e4f5a6b7c8d9e'; // 40 characters, like an Odoo key

  it('finds a key pasted twice or three times', () => {
    expect(isRepeatedPaste(key + key)).toBe(true);
    expect(isRepeatedPaste(key + key + key)).toBe(true);
    // An Atlassian-length token pasted twice.
    const token = 'ATATT3xFfGF0' + 'q'.repeat(10) + 'Z9'.repeat(85);
    expect(isRepeatedPaste(token + token)).toBe(true);
  });

  it('leaves a single key, a near-repeat and padding alone', () => {
    expect(isRepeatedPaste(key)).toBe(false);
    expect(isRepeatedPaste(key + key.slice(0, 39) + 'x')).toBe(false);
    expect(isRepeatedPaste('abcabc')).toBe(false); // too short to be a key
    expect(isRepeatedPaste('-'.repeat(40))).toBe(false);
  });
});

describe('checkAdapterEnvValues', () => {
  it('names a MySQL host left as the literal "host"', () => {
    const fields = checkAdapterEnvValues(adapter('mysql'), {
      MYSQL_HOST: 'host',
      MYSQL_PORT: '3306',
      MYSQL_DATABASE: 'shop',
      MYSQL_USER: 'reader',
      MYSQL_PASSWORD: 's3cret-Pass',
    });
    expect(Object.keys(fields)).toEqual(['MYSQL_HOST']);
    expect(fields.MYSQL_HOST).toMatch(/not the real address/);
  });

  it('applies the adapter pattern: an Odoo address with /web after the host', () => {
    const fields = checkAdapterEnvValues(adapter('odoo'), {
      ODOO_URL: 'https://erp.acme.de/web',
      ODOO_DB: 'acme',
      ODOO_API_KEY: 'a3f9c27e18d04b5f9e6a7c1d2b3e4f5a6b7c8d9e',
    });
    expect(Object.keys(fields)).toEqual(['ODOO_URL']);
    expect(fields.ODOO_URL).toMatch(/nothing after the host/);
  });

  it('refuses an Odoo key pasted three times', () => {
    const key = 'a3f9c27e18d04b5f9e6a7c1d2b3e4f5a6b7c8d9e';
    const fields = checkAdapterEnvValues(adapter('odoo'), {
      ODOO_URL: 'https://erp.acme.de',
      ODOO_DB: 'acme',
      ODOO_API_KEY: key.repeat(3),
    });
    expect(fields).toEqual({ ODOO_API_KEY: expect.stringMatching(/pasted more than once\. Paste it once\./) });
  });

  it('refuses a Bitrix24 CRM page where the inbound webhook URL goes', () => {
    const page = checkAdapterEnvValues(adapter('bitrix24'), {
      BITRIX24_WEBHOOK_URL: 'https://acme.bitrix24.com/crm/lead/kanban/',
    });
    expect(page.BITRIX24_WEBHOOK_URL).toMatch(/Inbound webhook/);
    expect(
      checkAdapterEnvValues(adapter('bitrix24'), { BITRIX24_WEBHOOK_URL: 'https://acme.bitrix24.com/rest/1/abc123def456ghi7/' }),
    ).toEqual({});
  });

  it('accepts real values and skips empty ones, placeholders and names it is not asked about', () => {
    expect(
      checkAdapterEnvValues(adapter('odoo'), {
        ODOO_URL: 'https://acme.odoo.com',
        ODOO_DB: '',
        ODOO_API_KEY: '{{ODOO_API_KEY}}',
      }),
    ).toEqual({});
    expect(
      checkAdapterEnvValues(adapter('mysql'), { MYSQL_HOST: 'host', MYSQL_DATABASE: 'shop' }, ['MYSQL_DATABASE']),
    ).toEqual({});
  });
});

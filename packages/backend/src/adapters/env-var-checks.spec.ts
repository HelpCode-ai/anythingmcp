import { checkAdapterEnvValues, isRepeatedPaste, placeholderReason } from './env-var-checks';
import { getAdapter } from './catalog';

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

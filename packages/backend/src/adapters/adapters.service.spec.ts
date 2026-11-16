import { BadRequestException } from '@nestjs/common';
import { AdaptersService } from './adapters.service';
import { outboundRequest } from '../common/outbound-http';

// The pre-sign-in check of the app keys (Etsy) goes out through this; no
// test here may reach a real provider.
jest.mock('../common/outbound-http', () => ({
  ...jest.requireActual('../common/outbound-http'),
  outboundRequest: jest.fn(),
}));
const outbound = outboundRequest as jest.MockedFunction<typeof outboundRequest>;

/**
 * Placeholder resolution for adapter credentials.
 *
 * `resolveString` / `resolveTemplate` are private, so these drive them through
 * the same object shapes `importAdapter` passes: `connector.authConfig`,
 * `connector.headers` and `connector.baseUrl`.
 */
describe('AdaptersService placeholder resolution', () => {
  // The service only needs its own methods here; the Prisma/config deps are
  // untouched by the resolution path.
  const service = Object.create(
    AdaptersService.prototype,
  ) as AdaptersService & {
    resolveString(str: string, creds?: Record<string, string>): string;
    resolveTemplate(value: unknown, creds?: Record<string, string>): unknown;
  };

  const resolveString = (s: string, creds?: Record<string, string>) =>
    (service as any).resolveString(s, creds);
  const resolveTemplate = (v: unknown, creds?: Record<string, string>) =>
    (service as any).resolveTemplate(v, creds);

  it('substitutes a supplied credential', () => {
    expect(
      resolveString('{{DESTATIS_USERNAME_OR_TOKEN}}', {
        DESTATIS_USERNAME_OR_TOKEN: 'abc123',
      }),
    ).toBe('abc123');
  });

  it('resolves an explicitly empty credential to empty, not to the placeholder', () => {
    // Destatis GENESIS wants the `password` header present but blank when the
    // caller identifies with an API token. Falling back to the placeholder
    // would send the literal string "{{DESTATIS_PASSWORD}}" as the password.
    expect(resolveString('{{DESTATIS_PASSWORD}}', { DESTATIS_PASSWORD: '' })).toBe(
      '',
    );
  });

  it('keeps the placeholder when the key is absent', () => {
    // "Import now, fill credentials in later" relies on this: an unresolved
    // placeholder is what the connector editor shows the operator.
    expect(resolveString('{{DESTATIS_PASSWORD}}', {})).toBe(
      '{{DESTATIS_PASSWORD}}',
    );
    expect(resolveString('{{DESTATIS_PASSWORD}}', undefined)).toBe(
      '{{DESTATIS_PASSWORD}}',
    );
  });

  it('resolves a whole authConfig, blanks included', () => {
    expect(
      resolveTemplate(
        {
          headerName: 'username',
          apiKey: '{{DESTATIS_USERNAME_OR_TOKEN}}',
          extraHeaders: { password: '{{DESTATIS_PASSWORD}}' },
        },
        { DESTATIS_USERNAME_OR_TOKEN: 'token-value', DESTATIS_PASSWORD: '' },
      ),
    ).toEqual({
      headerName: 'username',
      apiKey: 'token-value',
      extraHeaders: { password: '' },
    });
  });

  it('substitutes inside a longer string and leaves other text alone', () => {
    expect(
      resolveString('https://{{TENANT}}.weclapp.com/webapp/api/v1', {
        TENANT: 'acme',
      }),
    ).toBe('https://acme.weclapp.com/webapp/api/v1');
  });

  it('leaves non-string leaves untouched', () => {
    expect(resolveTemplate({ n: 42, b: true, nil: null }, { X: 'y' })).toEqual({
      n: 42,
      b: true,
      nil: null,
    });
  });

  /**
   * baseUrl is the one place where keeping the placeholder is fatal rather
   * than merely deferred: the connector gets created, looks fine in the UI,
   * and every call dies in the SSRF guard against a literal `{{VAR}}` host.
   */
  describe('assertBaseUrlFullyResolved', () => {
    // (slug, the adapter's template, the URL after substitution)
    const assertResolved = (slug: string, template: string, resolved = template) =>
      (service as any).assertBaseUrlFullyResolved(slug, template, resolved);

    it('accepts a fully resolved URL', () => {
      expect(() =>
        assertResolved('weclapp', 'https://acme.weclapp.com/webapp/api/v1'),
      ).not.toThrow();
    });

    it('rejects a bare placeholder and names the variable', () => {
      expect(() => assertResolved('amazon-seller', '{{SPAPI_ENDPOINT}}')).toThrow(
        BadRequestException,
      );
      expect(() => assertResolved('amazon-seller', '{{SPAPI_ENDPOINT}}')).toThrow(
        /SPAPI_ENDPOINT is required to install "amazon-seller"/,
      );
    });

    it('rejects a placeholder embedded in a path', () => {
      expect(() =>
        assertResolved('magento', '{{MAGENTO_BASE_URL}}/rest/default/V1'),
      ).toThrow(/MAGENTO_BASE_URL/);
    });

    it('names every missing variable once, and reads as a plural', () => {
      let message = '';
      try {
        assertResolved('x', 'https://{{A}}.example.com/{{B}}/{{A}}');
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toContain('A and B are required');
      expect(message).toContain('they form');
    });

    it('rejects a whole URL pasted into a fragment variable', () => {
      // What actually happened to insightly in production: the pod name field
      // got a full URL, the result parsed as a valid URL with host "api.https",
      // and every call failed with "cannot resolve 'api.https'".
      expect(() =>
        assertResolved(
          'insightly',
          'https://api.{{INSIGHTLY_POD}}.insightly.com/v3.1',
          'https://api.https://api.na1.insightly.com/v3.1.insightly.com/v3.1',
        ),
      ).toThrow(/looks like a full URL/);
    });

    it('leaves a correctly-filled templated URL alone', () => {
      expect(() =>
        assertResolved(
          'insightly',
          'https://api.{{INSIGHTLY_POD}}.insightly.com/v3.1',
          'https://api.na1.insightly.com/v3.1',
        ),
      ).not.toThrow();
    });

    it('does not echo a resolved secret back in the message', () => {
      // telegram-bot templates the bot token straight into the path, so the
      // hint has to show the shape of the URL without the parts that resolved.
      let message = '';
      try {
        assertResolved(
          'telegram-bot',
          'https://api.telegram.org/bot{{TELEGRAM_BOT_TOKEN}}/{{CHAT_ID}}',
          'https://api.telegram.org/bot12345:SECRET/{{CHAT_ID}}',
        );
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toContain('CHAT_ID');
      expect(message).not.toContain('SECRET');
      expect(message).not.toContain('12345');
    });
  });
});

describe('AdaptersService import probe', () => {
  const service = Object.create(AdaptersService.prototype) as AdaptersService;
  const runImportProbe = (adapter: unknown) =>
    (service as any).runImportProbe(adapter, 'connector-1');

  it('does not probe a connector that is authorised in the browser after install', async () => {
    // No token exists until the user clicks "Authorize with Provider", so the
    // only possible result is a 401 that the install form would present as a
    // wrong credential. The service's dependencies are deliberately absent:
    // reaching Prisma or the engine would throw.
    const probe = await runImportProbe({
      connector: {
        authType: 'OAUTH2',
        authConfig: {
          clientId: 'id',
          clientSecret: 'secret',
          authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
          tokenUrl: 'https://oauth2.googleapis.com/token',
        },
      },
      tools: [{ name: 'list', parameters: {}, endpointMapping: { method: 'GET', path: '/x' } }],
    });
    expect(probe).toBeNull();
  });

  // Etsy and Pinterest take either a pasted refresh token or the browser
  // flow; the template always says {{ETSY_REFRESH_TOKEN}}, so the decision is
  // made on what the install resolved it to.
  const etsyLike = {
    connector: {
      authType: 'OAUTH2',
      authConfig: {
        clientId: '{{ETSY_CLIENT_ID}}',
        refreshToken: '{{ETSY_REFRESH_TOKEN}}',
        authorizationUrl: 'https://www.etsy.com/oauth/connect',
        tokenUrl: 'https://api.etsy.com/v3/public/oauth/token',
      },
    },
    tools: [{ name: 'me', parameters: {}, endpointMapping: { method: 'GET', path: '/users/me' } }],
  };

  it('does not probe when the refresh token was left empty for the browser flow', async () => {
    const probe = await (service as any).runImportProbe(etsyLike, 'connector-1', {
      ...etsyLike.connector.authConfig,
      clientId: 'keystring',
      refreshToken: '',
    });
    expect(probe).toBeNull();
  });

  it('still probes when a refresh token was pasted, as it always has', async () => {
    const probing = Object.create(AdaptersService.prototype) as any;
    probing.prisma = { connector: { findUnique: jest.fn().mockResolvedValue(null) } };
    await probing.runImportProbe(etsyLike, 'connector-1', {
      ...etsyLike.connector.authConfig,
      clientId: 'keystring',
      refreshToken: '12345678.pasted',
    });
    expect(probing.prisma.connector.findUnique).toHaveBeenCalled();
  });
});

describe('AdaptersService install — a base URL variable without https://', () => {
  function build() {
    const prisma = {
      connector: {
        create: jest.fn().mockResolvedValue({ id: 'c1' }),
        // The import probe looks the connector up; nothing found = no probe.
        findUnique: jest.fn().mockResolvedValue(null),
      },
      mcpTool: {
        create: jest.fn().mockResolvedValue({}),
        createMany: jest.fn(async ({ data }: any) => ({ count: data.length })),
      },
    };
    const service = new AdaptersService(
      prisma as any,
      { reloadConnectorTools: jest.fn().mockResolvedValue(undefined) } as any,
      { get: (k: string) => (k === 'ENCRYPTION_KEY' ? 'a'.repeat(48) : undefined) } as any,
      {} as any,
    );
    return { service, prisma };
  }

  it('stores yourname.substack.com as https://yourname.substack.com', async () => {
    const { service, prisma } = build();

    await service.importAdapter('substack', 'u1', 'org1', {
      SUBSTACK_PUBLICATION_URL: 'yourname.substack.com',
    });

    const { data } = prisma.connector.create.mock.calls[0][0];
    expect(data.baseUrl).toBe('https://yourname.substack.com');
    expect(data.config.baseUrlBaseline).toBe('https://yourname.substack.com');
    expect(data.envVars).toEqual({
      SUBSTACK_PUBLICATION_URL: 'https://yourname.substack.com',
    });
  });

  it('keeps the rest of the path the adapter appends', async () => {
    const { service, prisma } = build();

    await service.importAdapter('magento', 'u1', 'org1', {
      MAGENTO_BASE_URL: 'shop.example.com',
      MAGENTO_ACCESS_TOKEN: 'token',
    });

    const { data } = prisma.connector.create.mock.calls[0][0];
    expect(data.baseUrl).toBe('https://shop.example.com/rest/default/V1');
  });

  it('refuses a value that is not a web address, naming the variable', async () => {
    const { service, prisma } = build();

    await expect(
      service.importAdapter('substack', 'u1', 'org1', {
        SUBSTACK_PUBLICATION_URL: 'someone@example.com',
      }),
    ).rejects.toThrow(
      /^SUBSTACK_PUBLICATION_URL must be a full URL such as https:\/\/example\.com — it looks like an e-mail address/,
    );
    expect(prisma.connector.create).not.toHaveBeenCalled();
  });
});

describe('AdaptersService — values that cannot be the real ones', () => {
  function build() {
    const execute = jest.fn().mockResolvedValue([]);
    const prisma = {
      connector: { create: jest.fn().mockResolvedValue({ id: 'c1' }), findUnique: jest.fn().mockResolvedValue(null) },
      mcpTool: { create: jest.fn(), createMany: jest.fn(async ({ data }: any) => ({ count: data.length })) },
    };
    const service = new AdaptersService(
      prisma as any,
      { reloadConnectorTools: jest.fn().mockResolvedValue(undefined) } as any,
      { get: (k: string) => (k === 'ENCRYPTION_KEY' ? 'a'.repeat(48) : undefined) } as any,
      { executeConnectorCall: execute } as any,
    );
    return { service, prisma, execute };
  }
  const mysql = { MYSQL_PORT: '3306', MYSQL_DATABASE: 'shop', MYSQL_USER: 'reader', MYSQL_PASSWORD: 'pw-123456' };

  it('the check names a MySQL host left as "host" and sends nothing', async () => {
    const { service, execute } = build();
    const out: any = await service.verifyCredentials('mysql', 'org1', { ...mysql, MYSQL_HOST: 'host' });
    expect(out).toMatchObject({ ok: false, kind: 'invalid_input', fields: { MYSQL_HOST: expect.stringMatching(/not the real address/) } });
    expect(execute).not.toHaveBeenCalled();
  });

  it('the check applies the adapter pattern the form applies (Odoo address with /web)', async () => {
    const { service } = build();
    const out: any = await service.verifyCredentials('odoo', 'org1', {
      ODOO_URL: 'https://erp.acme.de/web',
      ODOO_DB: 'acme',
      ODOO_API_KEY: 'a3f9c27e18d04b5f9e6a7c1d2b3e4f5a6b7c8d9e',
    });
    expect(Object.keys(out.fields)).toEqual(['ODOO_URL']);
    expect(out.fields.ODOO_URL).toMatch(/Remove \/web after the host: https:\/\/erp\.acme\.de\./);
  });

  it('adds the missing https:// to an address before the pattern check, and calls with it', async () => {
    const { service, execute } = build();
    const out: any = await service.verifyCredentials('odoo', 'org1', {
      ODOO_URL: 'amcp-e2e-test.odoo.com',
      ODOO_DB: 'amcp-e2e-test',
      ODOO_API_KEY: 'a3f9c27e18d04b5f9e6a7c1d2b3e4f5a6b7c8d9e',
    });
    expect(out.fields).toBeUndefined();
    expect(execute).toHaveBeenCalled();
    expect(execute.mock.calls[0][0].envVars.ODOO_URL).toBe('https://amcp-e2e-test.odoo.com');
  });

  it('the install stores an address field outside the base URL with its https:// (Zoho accounts server)', async () => {
    const { service, prisma } = build();
    await service.importAdapter('zoho-mail', 'u1', 'org1', {
      ZOHO_MAIL_CLIENT_ID: '1000.ABCDEFGHIJKLMNOP',
      ZOHO_MAIL_CLIENT_SECRET: 'f00ba4c0ffee1234567890abcdef',
      ZOHO_MAIL_API_URL: 'mail.zoho.eu',
      ZOHO_MAIL_ACCOUNTS_URL: 'accounts.zoho.eu',
    });
    const data = prisma.connector.create.mock.calls[0][0].data;
    expect(data.envVars).toMatchObject({
      ZOHO_MAIL_API_URL: 'https://mail.zoho.eu',
      ZOHO_MAIL_ACCOUNTS_URL: 'https://accounts.zoho.eu',
    });
  });

  it('"Save anyway" (the install) refuses them too, before anything is written', async () => {
    const { service, prisma } = build();
    const key = 'a3f9c27e18d04b5f9e6a7c1d2b3e4f5a6b7c8d9e';
    await expect(
      service.importAdapter('odoo', 'u1', 'org1', { ODOO_URL: 'https://erp.acme.de', ODOO_DB: 'acme', ODOO_API_KEY: key + key }),
    ).rejects.toMatchObject({
      response: { code: 'invalid_values', fields: { ODOO_API_KEY: expect.stringMatching(/Paste it once/) } },
    });
    expect(prisma.connector.create).not.toHaveBeenCalled();
  });

  it('real values still go through', async () => {
    const { service, execute } = build();
    const out: any = await service.verifyCredentials('mysql', 'org1', { ...mysql, MYSQL_HOST: 'db.acme.internal' });
    expect(out.fields).toBeUndefined();
    expect(execute).toHaveBeenCalled();
  });

  describe('a variable with a fixed list of choices (envVarMeta.options)', () => {
    // No catalog adapter is pinned here: a real one with choices put on its address.
    const { getAdapter } = jest.requireActual('./catalog');
    const magento = getAdapter('magento');
    const withChoices = {
      ...magento,
      envVarMeta: {
        ...magento.envVarMeta,
        MAGENTO_BASE_URL: {
          label: 'Country',
          kind: 'address',
          options: [
            { value: 'https://fr.shop.example.test', label: 'France' },
            { value: 'https://es.shop.example.test', label: 'Spain' },
          ],
        },
      },
    };
    const buildWithChoices = () => {
      const built = build();
      jest.spyOn(built.service, 'getBySlug').mockReturnValue(withChoices);
      return built;
    };
    const refusal = 'Country must be one of: France (https://fr.shop.example.test), Spain (https://es.shop.example.test).';

    it('describes the choices to the setup form', () => {
      const { service } = buildWithChoices();
      const address = service.describe('magento').envVars.find((v) => v.name === 'MAGENTO_BASE_URL');
      expect(address?.options).toEqual(withChoices.envVarMeta.MAGENTO_BASE_URL.options);
      expect(build().service.describe('magento').envVars.every((v) => !('options' in v))).toBe(true);
    });

    it('the check refuses a value that is not one of them and sends nothing', async () => {
      const { service, execute } = buildWithChoices();
      const out: any = await service.verifyCredentials('magento', 'org1', {
        MAGENTO_BASE_URL: 'https://de.shop.example.test',
        MAGENTO_ACCESS_TOKEN: 'not-a-real-token',
      });
      expect(out).toMatchObject({ ok: false, kind: 'invalid_input', fields: { MAGENTO_BASE_URL: refusal }, message: refusal });
      expect(execute).not.toHaveBeenCalled();
    });

    it('the check and the install accept a listed value', async () => {
      const { service, execute, prisma } = buildWithChoices();
      const values = { MAGENTO_BASE_URL: 'https://es.shop.example.test', MAGENTO_ACCESS_TOKEN: 'not-a-real-token' };
      const out: any = await service.verifyCredentials('magento', 'org1', values);
      expect(out.fields).toBeUndefined();
      expect(execute).toHaveBeenCalled();

      await service.importAdapter('magento', 'u1', 'org1', values);
      const { data } = prisma.connector.create.mock.calls[0][0];
      expect(data.baseUrl).toBe('https://es.shop.example.test/rest/default/V1');
      expect(data.envVars).toMatchObject({ MAGENTO_BASE_URL: 'https://es.shop.example.test' });
    });

    it('"Save anyway" (the install) refuses another value, before anything is written', async () => {
      const { service, prisma } = buildWithChoices();
      await expect(
        service.importAdapter('magento', 'u1', 'org1', {
          MAGENTO_BASE_URL: 'https://shop.example.test',
          MAGENTO_ACCESS_TOKEN: 'not-a-real-token',
        }),
      ).rejects.toMatchObject({ response: { code: 'invalid_values', fields: { MAGENTO_BASE_URL: refusal } } });
      expect(prisma.connector.create).not.toHaveBeenCalled();
    });
  });
});

describe('AdaptersService install — weclapp tenant pasted as an address (#733)', () => {
  function build() {
    const prisma = {
      connector: {
        create: jest.fn().mockResolvedValue({ id: 'c1' }),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      mcpTool: {
        create: jest.fn().mockResolvedValue({}),
        createMany: jest.fn(async ({ data }: any) => ({ count: data.length })),
      },
    };
    const service = new AdaptersService(
      prisma as any,
      { reloadConnectorTools: jest.fn().mockResolvedValue(undefined) } as any,
      { get: (k: string) => (k === 'ENCRYPTION_KEY' ? 'a'.repeat(48) : undefined) } as any,
      { executeConnectorCall: jest.fn() } as any,
    );
    return { service, prisma };
  }

  it('stores the tenant name only', async () => {
    const { service, prisma } = build();

    await service.importAdapter('weclapp', 'u1', 'org1', {
      WECLAPP_TENANT: 'https://acme.weclapp.com/webapp',
      WECLAPP_API_TOKEN: 't',
    });

    const { data } = prisma.connector.create.mock.calls[0][0];
    expect(data.baseUrl).toBe('https://acme.weclapp.com/webapp/api/v2');
    expect(data.envVars).toMatchObject({ WECLAPP_TENANT: 'acme' });
  });

  it('refuses an address on another domain, at install and in the pre-save check', async () => {
    const { service, prisma } = build();
    const message = /^WECLAPP_TENANT must be only the part before \.weclapp\.com, such as acme for acme\.weclapp\.com/;

    await expect(
      service.importAdapter('weclapp', 'u1', 'org1', { WECLAPP_TENANT: 'acme.example.com', WECLAPP_API_TOKEN: 't' }),
    ).rejects.toThrow(message);
    expect(prisma.connector.create).not.toHaveBeenCalled();

    const out: any = await service.verifyCredentials('weclapp', 'org1', {
      WECLAPP_TENANT: 'acme.example.com',
      WECLAPP_API_TOKEN: 't',
    });
    expect(out).toMatchObject({ ok: false, kind: 'invalid_input' });
    expect(out.message).toMatch(message);
  });
});

describe('AdaptersService install — a variable the operator provides (Deutsche Bahn)', () => {
  // 8-22 Oct 2026: every Deutsche Bahn install on Cloud answered 400
  // "MOTIS_URL is required": the setup form hid MOTIS_URL (the operator
  // provides it), and the import then no longer counted it as declared, so
  // the operator's value was never applied.
  const saved = process.env.MOTIS_INTERNAL_URL;
  afterEach(() => {
    if (saved === undefined) delete process.env.MOTIS_INTERNAL_URL;
    else process.env.MOTIS_INTERNAL_URL = saved;
  });

  function build(execute = jest.fn()) {
    const prisma = {
      connector: {
        create: jest.fn().mockResolvedValue({ id: 'c1' }),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      mcpTool: {
        create: jest.fn().mockResolvedValue({}),
        createMany: jest.fn(async ({ data }: any) => ({ count: data.length })),
      },
    };
    const service = new AdaptersService(
      prisma as any,
      { reloadConnectorTools: jest.fn().mockResolvedValue(undefined) } as any,
      { get: (k: string) => (k === 'ENCRYPTION_KEY' ? 'a'.repeat(48) : undefined) } as any,
      { executeConnectorCall: execute } as any,
    );
    return { service, prisma };
  }

  it('installs with the operator MOTIS and hides the variable from the form', async () => {
    process.env.MOTIS_INTERNAL_URL = 'http://motis:8080/';
    const { service, prisma } = build();

    expect(service.describe('deutsche-bahn').requiredEnvVars).toEqual([]);
    await service.importAdapter('deutsche-bahn', 'u1', 'org1', {});

    const { data } = prisma.connector.create.mock.calls[0][0];
    expect(data.baseUrl).toBe('http://motis:8080');
    expect(data.envVars).toMatchObject({ MOTIS_URL: 'http://motis:8080' });
  });

  it('installs with no credentials at all (setup from MCP, one-click)', async () => {
    process.env.MOTIS_INTERNAL_URL = 'http://motis:8080';
    const { service, prisma } = build();

    await service.importAdapter('deutsche-bahn', 'u1', 'org1');

    expect(prisma.connector.create.mock.calls[0][0].data.baseUrl).toBe('http://motis:8080');
  });

  it('ignores a MOTIS_URL posted by the user when the operator provides one', async () => {
    process.env.MOTIS_INTERNAL_URL = 'http://motis:8080';
    const { service, prisma } = build();

    await service.importAdapter('deutsche-bahn', 'u1', 'org1', { MOTIS_URL: 'http://169.254.169.254' });

    expect(prisma.connector.create.mock.calls[0][0].data.baseUrl).toBe('http://motis:8080');
  });

  it('verifies against the operator MOTIS before saving', async () => {
    process.env.MOTIS_INTERNAL_URL = 'http://motis:8080';
    const execute = jest.fn().mockResolvedValue([{ name: 'Freiburg Hbf' }]);
    const { service } = build(execute);

    const out = await service.verifyCredentials('deutsche-bahn', 'org1', {});

    expect(out).toMatchObject({ ok: true });
    // The adapter's probe (db_search_locations) ran against the operator MOTIS.
    expect(execute.mock.calls[0][0].baseUrl).toBe('http://motis:8080');
  });

  it('still asks for MOTIS_URL on a self-host without the bundled MOTIS', async () => {
    delete process.env.MOTIS_INTERNAL_URL;
    const { service, prisma } = build();

    expect(service.describe('deutsche-bahn').requiredEnvVars).toEqual(['MOTIS_URL']);
    await service.importAdapter('deutsche-bahn', 'u1', 'org1', { MOTIS_URL: 'https://motis.example.com' });
    expect(prisma.connector.create.mock.calls[0][0].data.baseUrl).toBe('https://motis.example.com');

    await expect(service.importAdapter('deutsche-bahn', 'u1', 'org1', {})).rejects.toThrow(
      /MOTIS_URL is required to install "deutsche-bahn"/,
    );
  });
});

describe('AdaptersService install — part of the address still to come', () => {
  function build(execute = jest.fn()) {
    const prisma = {
      connector: {
        create: jest.fn().mockResolvedValue({ id: 'c1' }),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      mcpTool: {
        create: jest.fn().mockResolvedValue({}),
        createMany: jest.fn(async ({ data }: any) => ({ count: data.length })),
      },
    };
    const service = new AdaptersService(
      prisma as any,
      { reloadConnectorTools: jest.fn().mockResolvedValue(undefined) } as any,
      { get: (k: string) => (k === 'ENCRYPTION_KEY' ? 'a'.repeat(48) : undefined) } as any,
      { executeConnectorCall: execute } as any,
    );
    return { service, prisma, execute };
  }

  it('still refuses an install without them by default', async () => {
    const { service, prisma } = build();
    await expect(service.importAdapter('telegram-bot', 'u1', 'org1', {})).rejects.toThrow(
      /TELEGRAM_BOT_TOKEN is required to install "telegram-bot"/,
    );
    expect(prisma.connector.create).not.toHaveBeenCalled();
  });

  it('creates the connector waiting for them with addressMayWait, and calls nothing', async () => {
    const { service, prisma, execute } = build();
    const out = await service.importAdapter('shopify', 'u1', 'org1', {}, { addressMayWait: true });

    const { data } = prisma.connector.create.mock.calls[0][0];
    expect(data.baseUrl).toContain('{{SHOPIFY_STORE}}');
    expect(out.probe).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });

  it('still refuses a whole URL pasted into an address part with addressMayWait', async () => {
    const { service } = build();
    await expect(
      service.importAdapter('insightly', 'u1', 'org1', { INSIGHTLY_POD: 'https://api.na1.insightly.com/v3.1' }, { addressMayWait: true }),
    ).rejects.toThrow();
  });
});

describe('AdaptersService starter pack', () => {
  const { STARTER_PACK } = jest.requireActual('./starter-pack');
  const { getAdapter } = jest.requireActual('./catalog');

  function service(opts: { mode?: string; installed?: string[] } = {}) {
    const svc = Object.create(AdaptersService.prototype) as AdaptersService;
    (svc as any).configService = { get: (k: string) => (k === 'DEPLOYMENT_MODE' ? opts.mode : undefined) };
    (svc as any).prisma = {
      connector: {
        findMany: jest.fn().mockResolvedValue(
          [...(opts.installed ?? []), null].map((slug) => ({ config: slug ? { adapterSlug: slug } : null })),
        ),
      },
    };
    return svc;
  }

  const saved = process.env.MOTIS_INTERNAL_URL;
  afterEach(() => {
    if (saved === undefined) delete process.env.MOTIS_INTERNAL_URL;
    else process.env.MOTIS_INTERNAL_URL = saved;
  });

  it('lists only adapters that exist, are keyless and install with no input', () => {
    for (const entry of STARTER_PACK) {
      const a = getAdapter(entry.slug);
      expect({ slug: entry.slug, exists: !!a }).toEqual({ slug: entry.slug, exists: true });
      expect({ slug: entry.slug, authType: a.connector.authType }).toEqual({ slug: entry.slug, authType: 'NONE' });
      expect({ slug: entry.slug, selfHostOnly: !!a.selfHostOnly }).toEqual({ slug: entry.slug, selfHostOnly: false });
      expect(entry.pitch.length).toBeLessThanOrEqual(110);
    }
    // Preselected demos took the trial's connector slots from the app the
    // user came for; the pack is opt-in now.
    expect(STARTER_PACK.filter((e: any) => e.preselected)).toEqual([]);
  });

  it('leaves out Deutsche Bahn unless the operator provides MOTIS', async () => {
    delete process.env.MOTIS_INTERNAL_URL;
    const without = await service().starterPack('org1');
    expect(without.map((i) => i.slug)).not.toContain('deutsche-bahn');

    process.env.MOTIS_INTERNAL_URL = 'http://motis:8080';
    const withMotis = await service({ mode: 'cloud' }).starterPack('org1');
    expect(withMotis.map((i) => i.slug)).toContain('deutsche-bahn');
  });

  it('marks what the workspace already has and carries the card fields', async () => {
    const items = await service({ installed: ['hackernews'] }).starterPack('org1');
    const hn = items.find((i) => i.slug === 'hackernews')!;
    expect(hn).toMatchObject({ installed: true, name: 'Hacker News', icon: 'hackernews', preselected: false });
    expect(hn.toolCount).toBeGreaterThan(0);
    expect(items.find((i) => i.slug === 'nominatim')!.installed).toBe(false);
    // Order follows the pack definition.
    expect(items.map((i) => i.slug)).toEqual(
      STARTER_PACK.map((e: any) => e.slug).filter((s: string) => s !== 'deutsche-bahn'),
    );
  });
});

describe('AdaptersService.verifyCredentials', () => {
  // Shaped like real Etsy app keys: the check enforces the adapter's patterns too.
  const ETSY_KEYS = { ETSY_CLIENT_ID: 'abcdefghij0123456789wxyz', ETSY_CLIENT_SECRET: 'sharedsecret01' };
  function build(execute: jest.Mock) {
    const prisma = { connector: { create: jest.fn() }, mcpTool: { create: jest.fn() } };
    const service = new AdaptersService(
      prisma as any,
      { reloadConnectorTools: jest.fn() } as any,
      { get: (k: string) => (k === 'ENCRYPTION_KEY' ? 'a'.repeat(48) : undefined) } as any,
      { executeConnectorCall: execute } as any,
    );
    return { service, prisma };
  }

  it('runs the probe with the given key in memory and writes nothing', async () => {
    const execute = jest.fn().mockResolvedValue({ companyName: 'Acme GmbH' });
    const { service, prisma } = build(execute);
    const out = await service.verifyCredentials('lexware-office', 'org1', { LEXWARE_API_KEY: ' key-1 ' });
    expect(out).toMatchObject({ ok: true, sample: expect.stringContaining('Acme GmbH') });
    const [connector] = execute.mock.calls[0];
    // No id: OAuth and login-token caches stay in memory.
    expect(connector.id).toBe('');
    expect(connector.envVars).toEqual({ LEXWARE_API_KEY: 'key-1' });
    expect(prisma.connector.create).not.toHaveBeenCalled();
  });

  it('reports a refused key as auth_failed, with the provider message', async () => {
    const err: any = new Error('401 Unauthorized: invalid token');
    err.status = 401;
    const { service } = build(jest.fn().mockRejectedValue(err));
    const out = await service.verifyCredentials('lexware-office', 'org1', { LEXWARE_API_KEY: 'bad' });
    expect(out).toMatchObject({ ok: false, kind: 'auth_failed', status: 401 });
  });

  it('shows the start of the provider answer when the error message lacks it', async () => {
    // 10 Oct 2026: a ShipStation user saw only "Request failed with status
    // code 500", without ShipStation's reason or the request id its support asks for.
    const err: any = new Error('Request failed with status code 500');
    err.response = {
      status: 500,
      data: { request_id: 'req-123', errors: [{ message: 'An internal error occurred.', error_code: 'unspecified' }] },
    };
    const { service } = build(jest.fn().mockRejectedValue(err));
    const out: any = await service.verifyCredentials('shipstation', 'org1', { SHIPSTATION_API_KEY: 'k'.repeat(32) });
    expect(out).toMatchObject({ ok: false, status: 500 });
    expect(out.message).toContain('ShipStation accepted the key');
    expect(out.message).toContain('req-123');
    expect(out.message).toContain('An internal error occurred.');
  });

  it('shows the words of a web page answer, never its markup', async () => {
    // 2 Nov 2026: an Odoo check showed "<html><body><script>window.location…".
    const err: any = new Error('Request failed with status code 404');
    err.response = {
      status: 404,
      data: '<!DOCTYPE html><html><head><title>Error</title><style>p{color:red}</style></head><body><h1>404 Not Found</h1><p>No route &amp; no page.</p></body></html>',
    };
    const { service } = build(jest.fn().mockRejectedValue(err));
    const out: any = await service.verifyCredentials('lexware-office', 'org1', { LEXWARE_API_KEY: 'k' });
    expect(out.message).toContain('the server answered with a web page: "Error 404 Not Found No route & no page."');
    expect(out.message).not.toMatch(/<|color:red/);
  });

  it('says a page with nothing to read is a web page, not API data', async () => {
    const err: any = new Error('Request failed with status code 404');
    err.response = { status: 404, data: '<html><body><script>window.location = "https://example.com/";</script></body></html>' };
    const { service } = build(jest.fn().mockRejectedValue(err));
    const out: any = await service.verifyCredentials('lexware-office', 'org1', { LEXWARE_API_KEY: 'k' });
    expect(out.message).toContain('the server answered with a web page, not API data');
    expect(out.message).not.toContain('window.location');
  });

  it('does not repeat a body the error message already carries', async () => {
    const err: any = new Error('401 Unauthorized: invalid token');
    err.status = 401;
    err.response = { status: 401, data: 'invalid token' };
    const { service } = build(jest.fn().mockRejectedValue(err));
    const out: any = await service.verifyCredentials('lexware-office', 'org1', { LEXWARE_API_KEY: 'bad' });
    expect(out.message.match(/invalid token/g)).toHaveLength(1);
  });

  it('names what is still empty without calling the API', async () => {
    const execute = jest.fn();
    const { service } = build(execute);
    const out = await service.verifyCredentials('weclapp', 'org1', { WECLAPP_API_TOKEN: 't' });
    expect(out).toMatchObject({ ok: false, kind: 'invalid_input', missing: ['WECLAPP_TENANT'] });
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses an address variable that is not one', async () => {
    const execute = jest.fn();
    const { service } = build(execute);
    const out = await service.verifyCredentials('substack', 'org1', { SUBSTACK_PUBLICATION_URL: 'not a url at all' });
    expect(out).toMatchObject({ ok: false, kind: 'invalid_input' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('checks the Etsy app keys before the sign-in, and goes ahead when Etsy accepts them', async () => {
    outbound.mockReset().mockResolvedValue({ status: 200, data: '{"application_id":1}' } as any);
    const execute = jest.fn();
    const { service } = build(execute);
    const out = await service.verifyCredentials('etsy', 'org1', ETSY_KEYS);
    expect(out).toEqual({ ok: null, skipped: 'authorization' });
    expect(execute).not.toHaveBeenCalled();
    expect(outbound).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        url: 'https://openapi.etsy.com/v3/application/openapi-ping',
        headers: { 'x-api-key': `${ETSY_KEYS.ETSY_CLIENT_ID}:${ETSY_KEYS.ETSY_CLIENT_SECRET}` },
      }),
    );
  });

  it('keeps the user on the setup page when Etsy does not accept the app keys yet', async () => {
    // 7 Oct 2026: every Etsy user who left for the sign-in and never came back
    // had keys Etsy answered this way (app still Pending, or wrong secret).
    outbound.mockReset().mockResolvedValue({
      status: 403,
      data: '{"error":"API key not found or not active, or incorrect shared secret for API key."}',
    } as any);
    const { service } = build(jest.fn());
    const out = await service.verifyCredentials('etsy', 'org1', ETSY_KEYS);
    expect(out).toMatchObject({ ok: false, kind: 'auth_failed', status: 403 });
    expect((out as any).message).toContain('stays Pending Personal Approval until Etsy approves it');
    expect((out as any).message).toContain('API key not found or not active');
    // Watched: the page keeps the keys and the owner hears when Etsy approves.
    expect(out).toMatchObject({ appPending: true });
  });

  it('flags only a 403 of a watched adapter as waiting for approval', async () => {
    outbound.mockReset().mockResolvedValue({ status: 401, data: 'nope' } as any);
    const { service } = build(jest.fn());
    const out = await service.verifyCredentials('etsy', 'org1', ETSY_KEYS);
    expect(out).toMatchObject({ ok: false, status: 401 });
    expect((out as any).appPending).toBeUndefined();
  });

  it('re-checks stored app keys with the same call: accepted, refused or unknown', async () => {
    const { service } = build(jest.fn());
    const env = { ETSY_CLIENT_ID: 'ks', ETSY_CLIENT_SECRET: 'ss' };
    const base = 'https://openapi.etsy.com/v3/application';
    outbound.mockReset().mockResolvedValue({ status: 200, data: '{}' } as any);
    expect(await service.recheckAppKeys('etsy', base, env)).toBe('accepted');
    expect(outbound).toHaveBeenCalledWith(
      expect.objectContaining({ url: `${base}/openapi-ping`, headers: { 'x-api-key': 'ks:ss' } }),
    );
    outbound.mockReset().mockResolvedValue({ status: 403, data: 'pending' } as any);
    expect(await service.recheckAppKeys('etsy', base, env)).toBe('refused');
    outbound.mockReset().mockResolvedValue({ status: 503, data: 'down' } as any);
    expect(await service.recheckAppKeys('etsy', base, env)).toBe('unknown');
    outbound.mockReset().mockRejectedValue(new Error('ETIMEDOUT'));
    expect(await service.recheckAppKeys('etsy', base, env)).toBe('unknown');
    // A key missing: nothing is sent.
    outbound.mockReset();
    expect(await service.recheckAppKeys('etsy', base, { ETSY_CLIENT_ID: 'ks' })).toBe('unknown');
    expect(outbound).not.toHaveBeenCalled();
    expect(await service.recheckAppKeys('google-search-console', base, env)).toBe('unknown');
  });

  it('does not hold the sign-in back when Etsy cannot be reached or answers something else', async () => {
    const { service } = build(jest.fn());
    outbound.mockReset().mockRejectedValue(new Error('ETIMEDOUT'));
    expect(await service.verifyCredentials('etsy', 'org1', ETSY_KEYS)).toEqual({
      ok: null,
      skipped: 'authorization',
    });
    outbound.mockReset().mockResolvedValue({ status: 503, data: 'down' } as any);
    expect(await service.verifyCredentials('etsy', 'org1', ETSY_KEYS)).toEqual({
      ok: null,
      skipped: 'authorization',
    });
  });

  it('has nothing to check before the sign-in for an OAuth adapter without app-key check', async () => {
    outbound.mockReset();
    const { service } = build(jest.fn());
    const out = await service.verifyCredentials('google-search-console', 'org1', {
      GOOGLE_CLIENT_ID: '1234567890-abc.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'secret',
    });
    expect(out).toEqual({ ok: null, skipped: 'authorization' });
    expect(outbound).not.toHaveBeenCalled();
  });
});

describe('AdaptersService.exerciseReadTools', () => {
  const adapter: any = {
    slug: 'acme',
    name: 'Acme',
    requiredEnvVars: ['ACME_KEY'],
    connector: {
      name: 'Acme API',
      type: 'REST',
      baseUrl: 'https://api.acme.example',
      authType: 'BEARER_TOKEN',
      authConfig: { token: '{{ACME_KEY}}' },
    },
    tools: [
      { name: 'acme_list_orders', parameters: { type: 'object', properties: {} }, endpointMapping: { method: 'GET', path: '/orders' } },
      {
        name: 'acme_get_order',
        parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        endpointMapping: { method: 'GET', path: '/orders/{id}' },
      },
      {
        name: 'acme_search',
        annotations: { readOnlyHint: true },
        parameters: { type: 'object', properties: {} },
        endpointMapping: { method: 'POST', path: '/search' },
      },
      { name: 'acme_create_order', parameters: { type: 'object', properties: {} }, endpointMapping: { method: 'POST', path: '/orders' } },
      { name: 'acme_delete_order', parameters: { type: 'object', properties: {} }, endpointMapping: { method: 'DELETE', path: '/orders/1' } },
    ],
  };

  function build(execute: jest.Mock) {
    const prisma = { connector: { create: jest.fn() }, mcpTool: { create: jest.fn() } };
    const service = new AdaptersService(
      prisma as any,
      { reloadConnectorTools: jest.fn() } as any,
      { get: (k: string) => (k === 'ENCRYPTION_KEY' ? 'a'.repeat(48) : undefined) } as any,
      { executeConnectorCall: execute } as any,
    );
    return { service, prisma };
  }

  it('runs only read-only tools, in memory, and reports shapes but no data', async () => {
    const execute = jest.fn(async (_c: any, em: any) =>
      em.path === '/orders' ? [{ id: 'o1', total: 99, customer: 'Jane' }] : { hits: [], total: 0 },
    );
    const { service, prisma } = build(execute);
    const out = await service.exerciseReadTools(adapter, 'org1', { ACME_KEY: 'k' }, { params: { acme_get_order: { id: 'o1' } } });

    expect(out.map((r) => [r.tool, r.outcome])).toEqual([
      ['acme_list_orders', 'ok'],
      ['acme_get_order', 'ok'],
      ['acme_search', 'ok'],
      ['acme_create_order', 'skipped'],
      ['acme_delete_order', 'skipped'],
    ]);
    expect(execute.mock.calls.map(([, em]) => `${em.method} ${em.path}`)).toEqual([
      'GET /orders',
      'GET /orders/{id}',
      'POST /search',
    ]);
    expect(execute.mock.calls[0][0].id).toBe('');
    expect(out[0]).toMatchObject({ shape: 'array(1) of {id,total,customer}' });
    expect(JSON.stringify(out)).not.toContain('Jane');
    expect(prisma.connector.create).not.toHaveBeenCalled();
  });

  it('skips a tool whose required argument was not given, and reports errors with their status', async () => {
    const err: any = new Error('403 Forbidden');
    err.status = 403;
    const { service } = build(jest.fn().mockRejectedValue(err));
    const out = await service.exerciseReadTools(adapter, 'org1', { ACME_KEY: 'k' }, { only: ['acme_list_orders', 'acme_get_order'] });
    expect(out).toEqual([
      expect.objectContaining({ tool: 'acme_list_orders', outcome: 'error', status: 403 }),
      { tool: 'acme_get_order', outcome: 'skipped', reason: 'needs id' },
    ]);
  });
});

describe('AdaptersService.verifyCredentials on an existing connector', () => {
  it('fills a field left empty from what the connector stores, only within the organization', async () => {
    const execute = jest.fn().mockResolvedValue({ ok: 1 });
    const findFirst = jest.fn().mockResolvedValue({ envVars: { LEXWARE_API_KEY: 'stored-key' } });
    const service = new AdaptersService(
      { connector: { findFirst } } as any,
      { reloadConnectorTools: jest.fn() } as any,
      { get: (k: string) => (k === 'ENCRYPTION_KEY' ? 'a'.repeat(48) : undefined) } as any,
      { executeConnectorCall: execute } as any,
    );
    const out = await service.verifyCredentials('lexware-office', 'org1', { LEXWARE_API_KEY: '' }, 'c1');
    expect(out.ok).toBe(true);
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'c1', organizationId: 'org1' } }));
    expect(execute.mock.calls[0][0].envVars).toEqual({ LEXWARE_API_KEY: 'stored-key' });
  });
});

describe('AdaptersService.verifyCredentials with an optional variable left empty', () => {
  const sqlLogin = { MSSQL_HOST: 'db.example.com', MSSQL_PORT: '1433', MSSQL_DATABASE: 'erp', MSSQL_USER: 'reader', MSSQL_PASSWORD: '' };
  function build(stored: Record<string, string>) {
    const execute = jest.fn().mockResolvedValue({ ok: 1 });
    const service = new AdaptersService(
      { connector: { findFirst: jest.fn().mockResolvedValue({ envVars: stored }) } } as any,
      { reloadConnectorTools: jest.fn() } as any,
      { get: (k: string) => (k === 'ENCRYPTION_KEY' ? 'a'.repeat(48) : undefined) } as any,
      { executeConnectorCall: execute } as any,
    );
    return { service, execute };
  }

  it('finishing a connector: an empty MSSQL_DOMAIN is a SQL login, not "still empty"', async () => {
    // Libredesk #123: the connector was installed from a chat without the
    // optional variable; the form sent it empty and the check dropped it.
    const { service } = build({ ...sqlLogin, MSSQL_PASSWORD: 'stored-pw' });
    const out: any = await service.verifyCredentials('mssql', 'org1', { ...sqlLogin, MSSQL_DOMAIN: '' }, 'c1');
    expect(out.kind).not.toBe('invalid_input');
    expect(out.missing).toBeUndefined();
  });

  it('clearing a domain set earlier switches back to a SQL login', async () => {
    const { service, execute } = build({ ...sqlLogin, MSSQL_PASSWORD: 'stored-pw', MSSQL_DOMAIN: 'CORP' });
    const out: any = await service.verifyCredentials('mssql', 'org1', { ...sqlLogin, MSSQL_DOMAIN: '' }, 'c1');
    expect(out.kind).not.toBe('invalid_input');
    expect(execute.mock.calls[0][0].envVars).toMatchObject({ MSSQL_DOMAIN: '', MSSQL_PASSWORD: 'stored-pw' });
  });
});

describe('AdaptersService unlisted adapters', () => {
  const { getAdapter } = jest.requireActual('./catalog');

  function service(mode?: string) {
    const svc = Object.create(AdaptersService.prototype) as AdaptersService;
    (svc as any).configService = { get: (k: string) => (k === 'DEPLOYMENT_MODE' ? mode : undefined) };
    return svc;
  }

  // Did not match the vendor's API and could not be verified (Oct 2026 audit).
  const unlisted = ['teamsystem', 'sage-100', 'elo', 'cas-genesisworld', 'zucchetti', 'payone'];

  it('are neither listed nor installable, on the cloud or on self-host', () => {
    for (const mode of ['cloud', undefined]) {
      const listed = service(mode).listAll().map((a) => a.slug);
      for (const slug of unlisted) {
        expect({ mode, slug, listed: listed.includes(slug) }).toEqual({ mode, slug, listed: false });
        expect(() => service(mode).getBySlug(slug)).toThrow(/not found/);
      }
    }
  });

  it('stay resolvable by slug, so connectors installed earlier keep their icon and re-sync', () => {
    for (const slug of unlisted) expect(getAdapter(slug)?.unlisted).toBe(true);
  });
});

describe('AdaptersService popular connectors', () => {
  function service(opts: { rows?: Array<{ slug: string; workspaces: bigint }>; fail?: boolean; installed?: string[] } = {}) {
    const svc = Object.create(AdaptersService.prototype) as AdaptersService;
    (svc as any).logger = { warn: jest.fn() };
    (svc as any).configService = { get: (k: string) => (k === 'DEPLOYMENT_MODE' ? 'cloud' : undefined) };
    const queryRaw = opts.fail
      ? jest.fn().mockRejectedValue(new Error('db down'))
      : jest.fn().mockResolvedValue(opts.rows ?? []);
    (svc as any).prisma = {
      $queryRaw: queryRaw,
      connector: {
        findMany: jest.fn().mockResolvedValue((opts.installed ?? []).map((slug) => ({ config: { adapterSlug: slug } }))),
      },
    };
    return { svc, queryRaw };
  }

  it('leads with what works for the most workspaces, then fills from the fallback', async () => {
    const { svc } = service({
      rows: [
        { slug: 'odoo', workspaces: 17n },
        { slug: 'telegram-bot', workspaces: 133n },
      ].sort((a, b) => Number(b.workspaces - a.workspaces)),
    });
    const items = await svc.popularConnectors('org1');
    expect(items.map((i) => i.slug).slice(0, 2)).toEqual(['telegram-bot', 'odoo']);
    expect(items).toHaveLength(8);
    expect(new Set(items.map((i) => i.slug)).size).toBe(8);
  });

  it('leaves keyless adapters to the starter pack', async () => {
    const { svc } = service({ rows: [{ slug: 'hackernews', workspaces: 50n }, { slug: 'etsy', workspaces: 40n }] });
    const items = await svc.popularConnectors('org1');
    expect(items.map((i) => i.slug)).not.toContain('hackernews');
    expect(items[0].slug).toBe('etsy');
  });

  it('says what each setup asks for, without the token a sign-in fills in', async () => {
    const { svc } = service({ rows: [{ slug: 'etsy', workspaces: 40n }] });
    const etsy = (await svc.popularConnectors('org1')).find((i) => i.slug === 'etsy')!;
    expect(etsy.setupKind).toBe('oauth_browser');
    expect(etsy.needs).toEqual(['Keystring', 'Shared Secret']);
  });

  it('marks what the workspace already has', async () => {
    const { svc } = service({ rows: [{ slug: 'telegram-bot', workspaces: 9n }], installed: ['telegram-bot'] });
    const items = await svc.popularConnectors('org1');
    expect(items.find((i) => i.slug === 'telegram-bot')!.installed).toBe(true);
  });

  it('ranks once an hour, not on every page view', async () => {
    const { svc, queryRaw } = service({ rows: [{ slug: 'etsy', workspaces: 40n }] });
    await svc.popularConnectors('org1');
    await svc.popularConnectors('org2');
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it('serves the fallback list when the ranking query fails', async () => {
    const { svc } = service({ fail: true });
    const items = await svc.popularConnectors('org1');
    expect(items[0].slug).toBe('telegram-bot');
    expect(items.length).toBeGreaterThanOrEqual(4);
  });
});

describe('AdaptersService install ranking', () => {
  function service(opts: { rows?: Array<{ slug: string | null }>; fail?: boolean } = {}) {
    const svc = Object.create(AdaptersService.prototype) as AdaptersService;
    (svc as any).logger = { warn: jest.fn() };
    (svc as any).configService = { get: (k: string) => (k === 'DEPLOYMENT_MODE' ? 'cloud' : undefined) };
    const queryRaw = opts.fail
      ? jest.fn().mockRejectedValue(new Error('db down'))
      : jest.fn().mockResolvedValue(opts.rows ?? []);
    (svc as any).prisma = { $queryRaw: queryRaw };
    return { svc, queryRaw };
  }
  const slugsOf = async (svc: AdaptersService) => JSON.parse((await svc.installRanking()).body).slugs;

  it('keeps the order of the query, which ranks by installing workspaces', async () => {
    const { svc } = service({ rows: [{ slug: 'telegram-bot' }, { slug: 'etsy' }, { slug: 'odoo' }] });
    expect(await slugsOf(svc)).toEqual(['telegram-bot', 'etsy', 'odoo']);
  });

  it('sends only slugs, never a count, and asks for three workspaces that used it', async () => {
    const { svc, queryRaw } = service({ rows: [{ slug: 'etsy' }] });
    expect(JSON.parse((await svc.installRanking()).body)).toEqual({ slugs: ['etsy'] });
    const [sql, ...values] = queryRaw.mock.calls[0];
    expect(sql.join('?')).toMatch(/ti\.connector_id = c\.id AND ti\.status = 'SUCCESS'/);
    expect(sql.join('?')).toMatch(/HAVING COUNT\(DISTINCT c\.organization_id\) >= \?/);
    expect(values).toEqual([3]);
  });

  it('leaves out adapters that are not listed here (self-host only on the cloud, unknown, null)', async () => {
    const { svc } = service({ rows: [{ slug: 'etsy' }, { slug: 'no-such-adapter' }, { slug: 'idealista' }, { slug: null }] });
    expect(await slugsOf(svc)).toEqual(['etsy']);
  });

  it('ranks once per cache window, not on every request', async () => {
    const { svc, queryRaw } = service({ rows: [{ slug: 'etsy' }] });
    await svc.installRanking();
    await svc.installRanking();
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it('serves the last good ranking when the query fails, and an empty one before any', async () => {
    const { svc } = service({ fail: true });
    expect(await slugsOf(svc)).toEqual([]);

    const ok = service({ rows: [{ slug: 'etsy' }] });
    await ok.svc.installRanking();
    (ok.svc as any).installRankingCache.at = 0;
    (ok.svc as any).prisma.$queryRaw = jest.fn().mockRejectedValue(new Error('db down'));
    expect(await slugsOf(ok.svc)).toEqual(['etsy']);
  });
});

describe('sap-s4hana-cloud: token URL and refused client credentials', () => {
  const adapter = require('./intl/sap-s4hana-cloud.json');

  it('gives one token URL everywhere: the tenant API host, as OAuth 2.0 Details shows it', () => {
    // The BTP address appears only as the one not to use.
    const notToUse = /Do not use a BTP URL such as `[^`]+`/;
    expect(adapter.instructions).toMatch(notToUse);
    const tokenUrls = [adapter.instructions.replace(notToUse, ''), adapter.envVarMeta.S4_TOKEN_URL.example]
      .join('\n')
      .match(/https:\/\/[^\s`"]+\/oauth2?\/token/g);
    expect(tokenUrls?.length).toBeGreaterThanOrEqual(2);
    for (const url of tokenUrls!) {
      expect(url).toMatch(/^https:\/\/my\d+-api\.s4hana\.cloud\.sap\/sap\/bc\/sec\/oauth2\/token$/);
    }
    expect(adapter.instructions).toMatch(/https:\/\/my300000-api\.s4hana\.cloud\.sap`/);
  });

  it('lists the four causes when the token request is refused', async () => {
    const err: any = new Error(
      'OAuth2 client_credentials: could not obtain an access token from my123456-api.s4hana.cloud.sap (HTTP 401: invalid_client).',
    );
    err.status = 401;
    const service = new AdaptersService(
      { connector: { create: jest.fn() }, mcpTool: { create: jest.fn() } } as any,
      { reloadConnectorTools: jest.fn() } as any,
      { get: (k: string) => (k === 'ENCRYPTION_KEY' ? 'a'.repeat(48) : undefined) } as any,
      { executeConnectorCall: jest.fn().mockRejectedValue(err) } as any,
    );
    const out: any = await service.verifyCredentials('sap-s4hana-cloud', 'org1', {
      S4_BASE_URL: 'https://my123456-api.s4hana.cloud.sap',
      S4_TOKEN_URL: 'https://my123456-api.s4hana.cloud.sap/sap/bc/sec/oauth2/token',
      S4_CLIENT_ID: 'COMM_USER',
      S4_CLIENT_SECRET: 'secret',
    });
    expect(out).toMatchObject({ ok: false, status: 401 });
    expect(out.message).toMatch(/\(1\) the token URL/);
    expect(out.message).toMatch(/\(2\) the client ID and secret are those of the communication user/);
    expect(out.message).toMatch(/\(3\) a communication arrangement exists/);
    expect(out.message).toMatch(/\(4\) no scope is set/);
    expect(out.message).toContain('invalid_client');
  });
});

describe('AdaptersService.verifyCredentials: Odoo JSON-2 answering 404', () => {
  // Two stuck users in October 2026 were on Odoo 19 with a wrong database
  // name: the old hint ("older than 19, or the database name is wrong")
  // offered the JSON-RPC connector, and they failed there too.
  const creds = { ODOO_URL: 'https://binikit.odoo.com', ODOO_DB: 'binikit', ODOO_API_KEY: 'k' };

  function build() {
    const err: any = new Error('404 NOT FOUND: Request failed with status code 404');
    err.status = 404;
    return new AdaptersService(
      { connector: { create: jest.fn() }, mcpTool: { create: jest.fn() } } as any,
      { reloadConnectorTools: jest.fn() } as any,
      { get: (k: string) => (k === 'ENCRYPTION_KEY' ? 'a'.repeat(48) : undefined) } as any,
      { executeConnectorCall: jest.fn().mockRejectedValue(err) } as any,
    );
  }

  /** Answers Odoo's routes: `version` for /jsonrpc, `databases` for /web/database/list. */
  function odooAnswers(opts: { version?: unknown[]; serie?: string; databases?: string[]; typo?: boolean }) {
    outbound.mockReset();
    outbound.mockImplementation(async (config: any) => {
      if (opts.typo) {
        return {
          status: 404,
          data: '<html><body><script>window.location = `https://www.odoo.com/typo?domain=binikit.odoo.com&autodbname=binikit`;</script></body></html>',
        } as any;
      }
      if (config.url.endsWith('/jsonrpc')) {
        return { status: 200, data: { result: { server_version_info: opts.version, server_serie: opts.serie } } } as any;
      }
      if (config.url.endsWith('/web/database/list')) {
        return { status: 200, data: { result: opts.databases ?? [] } } as any;
      }
      throw new Error(`unexpected ${config.url}`);
    });
  }

  afterEach(() => outbound.mockReset());

  it('offers the JSON-RPC connector only when Odoo says it is older than 19', async () => {
    odooAnswers({ version: [17, 0, 0, 'final', 0, ''], serie: '17.0' });
    const out: any = await build().verifyCredentials('odoo', 'org1', creds);
    expect(out).toMatchObject({ ok: false, suggest: 'odoo-jsonrpc' });
    expect(out.message).toMatch(/version 17\.0, older than 19/);
    expect(outbound).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://binikit.odoo.com/jsonrpc',
        data: expect.objectContaining({ params: { service: 'common', method: 'version', args: [] } }),
      }),
    );
  });

  it('below 19, offers the switch to the JSON-RPC setup with the address and database, never the key', async () => {
    odooAnswers({ version: [16, 0, 0, 'final', 0, ''], serie: '16.0' });
    const out: any = await build().verifyCredentials('odoo', 'org1', {
      // Typed without https://, as the address bar shows it.
      ODOO_URL: 'binikit.odoo.com',
      ODOO_DB: 'binikit',
      ODOO_API_KEY: 'a3f9c27e18d04b5f9e6a7c1d2b3e4f5a6b7c8d9e',
    });
    expect(out.switchTo).toEqual({
      slug: 'odoo-jsonrpc',
      name: 'Odoo 14-18 (JSON-RPC)',
      prefill: { ODOO_URL: 'https://binikit.odoo.com', ODOO_DB: 'binikit' },
    });
    expect(JSON.stringify(out.switchTo)).not.toContain('a3f9c27e');
  });

  it('on Odoo 19 says the database name is wrong and names the right one, at the root of the address', async () => {
    odooAnswers({ version: ['saas~19', 3, 0, 'final', 0, 'e'], serie: 'saas~19.3', databases: ['binikit-main-12245208'] });
    const out: any = await build().verifyCredentials('odoo', 'org1', creds);
    expect(out.ok).toBe(false);
    expect(out.suggest).toBeUndefined();
    expect(out.switchTo).toBeUndefined();
    expect(out.message).toMatch(/version saas~19\.3 and has the JSON-2 API, so the database name "binikit" is wrong/);
    expect(out.message).toContain('"binikit-main-12245208"');
    const urls = outbound.mock.calls.map(([c]: any) => c.url);
    expect(urls).toContain('https://binikit.odoo.com/web/database/list');
    expect(urls.some((u: string) => u.includes('/json/2/'))).toBe(false);
  });

  it("says the address is not an Odoo database on Odoo Online's typo page", async () => {
    odooAnswers({ typo: true });
    const out: any = await build().verifyCredentials('odoo', 'org1', creds);
    expect(out.ok).toBe(false);
    expect(out.suggest).toBeUndefined();
    expect(out.message).toMatch(/This address is not an Odoo database/);
    expect(out.message).toMatch(/Check the address you open Odoo at/);
  });

  /** The probe answers 404 unless ODOO_DB is `accepted`; there it answers `then` (ok, or a refused key). */
  function buildAccepting(accepted: string, then: 'ok' | 'auth') {
    const execute = jest.fn(async (connector: any) => {
      if (connector.envVars.ODOO_DB !== accepted) {
        throw Object.assign(new Error('404 NOT FOUND: Request failed with status code 404'), { status: 404 });
      }
      if (then === 'auth') {
        throw Object.assign(new Error('401 UNAUTHORIZED: Invalid apikey'), { status: 401 });
      }
      return [{ id: 1, name: 'My Company' }];
    });
    const svc = new AdaptersService(
      { connector: { create: jest.fn() }, mcpTool: { create: jest.fn() } } as any,
      { reloadConnectorTools: jest.fn() } as any,
      { get: (k: string) => (k === 'ENCRYPTION_KEY' ? 'a'.repeat(48) : undefined) } as any,
      { executeConnectorCall: execute } as any,
    );
    return { svc, execute };
  }

  it('tries the one database the address serves and returns it to fill in when Odoo accepts it', async () => {
    // 9 Nov 2026: 19 Odoo setups were stuck on a database name the check had
    // already named; none had typed it in.
    odooAnswers({ version: ['saas~19', 3, 0, 'final', 0, 'e'], serie: 'saas~19.3', databases: ['binikit-main-12245208'] });
    const { svc, execute } = buildAccepting('binikit-main-12245208', 'ok');
    const out: any = await svc.verifyCredentials('odoo', 'org1', creds);
    expect(out).toMatchObject({ ok: true, corrected: { ODOO_DB: 'binikit-main-12245208' } });
    expect(out.note).toContain('"binikit-main-12245208"');
    expect(out).not.toHaveProperty('odooDatabase');
    expect(execute.mock.calls.map(([c]: any) => c.envVars.ODOO_DB)).toEqual(['binikit', 'binikit-main-12245208']);
  });

  it('still fills in the database when only the key is refused with it', async () => {
    odooAnswers({ version: ['saas~19', 3, 0, 'final', 0, 'e'], serie: 'saas~19.3', databases: ['binikit-main-12245208'] });
    const { svc } = buildAccepting('binikit-main-12245208', 'auth');
    const out: any = await svc.verifyCredentials('odoo', 'org1', creds);
    expect(out).toMatchObject({ ok: false, kind: 'auth_failed', corrected: { ODOO_DB: 'binikit-main-12245208' } });
    expect(out.message).toMatch(/^Your Odoo's database is called "binikit-main-12245208": it is filled in for you\./);
  });

  it('does not guess between several databases, and keeps the first answer when the other fails the same way', async () => {
    odooAnswers({ version: [19, 0, 0, 'final', 0, ''], serie: '19.0', databases: ['prod', 'staging'] });
    const several = buildAccepting('prod', 'ok');
    const out: any = await several.svc.verifyCredentials('odoo', 'org1', creds);
    expect(out.ok).toBe(false);
    expect(out.corrected).toBeUndefined();
    expect(out).not.toHaveProperty('odooDatabase');
    expect(several.execute).toHaveBeenCalledTimes(1);

    odooAnswers({ version: [19, 0, 0, 'final', 0, ''], serie: '19.0', databases: ['other'] });
    const none = buildAccepting('nothing-matches', 'ok');
    const again: any = await none.svc.verifyCredentials('odoo', 'org1', creds);
    expect(again.ok).toBe(false);
    expect(again.corrected).toBeUndefined();
    expect(again.message).toContain('"other"');
    expect(again).not.toHaveProperty('odooDatabase');
    expect(none.execute).toHaveBeenCalledTimes(2);
  });

  it('keeps the old hint and suggestion when Odoo does not tell its version', async () => {
    outbound.mockReset();
    outbound.mockRejectedValue(new Error('ECONNREFUSED'));
    const out: any = await build().verifyCredentials('odoo', 'org1', creds);
    expect(out).toMatchObject({ ok: false, suggest: 'odoo-jsonrpc' });
    expect(out.message).toMatch(/older than 19, or the database name is wrong/);
  });
});

describe('AdaptersService check — a server that only accepts approved IPs', () => {
  const saved = process.env.EGRESS_IPS;
  afterEach(() => {
    if (saved === undefined) delete process.env.EGRESS_IPS;
    else process.env.EGRESS_IPS = saved;
  });

  function build(execute: jest.Mock) {
    return new AdaptersService(
      { connector: { findUnique: jest.fn().mockResolvedValue(null) } } as any,
      { reloadConnectorTools: jest.fn() } as any,
      {
        get: (k: string) =>
          k === 'ENCRYPTION_KEY' ? 'a'.repeat(48) : k === 'DEPLOYMENT_MODE' ? 'cloud' : undefined,
      } as any,
      { executeConnectorCall: execute } as any,
    );
  }

  it('names the address to allow when the firewall answers with a page', async () => {
    // 3 Nov 2026: a self-hosted Bitrix24 behind an IP allowlist answered 403
    // "Access Restricted"; the check said nothing the user could act on.
    process.env.EGRESS_IPS = '104.248.242.235';
    const execute = jest.fn().mockRejectedValue(
      Object.assign(new Error('Request failed with status code 403'), {
        response: {
          status: 403,
          data: '<!DOCTYPE html><html lang="en"><head><title>Access Restricted</title></head><body>Access Restricted</body></html>',
        },
      }),
    );
    const out: any = await build(execute).verifyCredentials('bitrix24', 'org1', {
      BITRIX24_WEBHOOK_URL: 'https://crm.example.com/rest/1/abcdef123456/',
    });
    expect(out).toMatchObject({ ok: false, status: 403 });
    expect(out.message).toMatch(/AnythingMCP Cloud calls every API from the fixed IP address 104\.248\.242\.235/);
  });

  it('keeps describing the adapter with the addresses to show', () => {
    process.env.EGRESS_IPS = '104.248.242.235';
    const info = build(jest.fn()).describe('emag-marketplace');
    expect(info.egressIps).toEqual(['104.248.242.235']);
    expect(info.requiresIpAllowlist).toBe(true);
  });
});

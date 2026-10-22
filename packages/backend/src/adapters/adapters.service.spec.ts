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
    const out = await service.verifyCredentials('etsy', 'org1', { ETSY_CLIENT_ID: 'ks', ETSY_CLIENT_SECRET: 'ss' });
    expect(out).toEqual({ ok: null, skipped: 'authorization' });
    expect(execute).not.toHaveBeenCalled();
    expect(outbound).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        url: 'https://openapi.etsy.com/v3/application/openapi-ping',
        headers: { 'x-api-key': 'ks:ss' },
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
    const out = await service.verifyCredentials('etsy', 'org1', { ETSY_CLIENT_ID: 'ks', ETSY_CLIENT_SECRET: 'ss' });
    expect(out).toMatchObject({ ok: false, kind: 'auth_failed', status: 403 });
    expect((out as any).message).toContain('stays Pending until Etsy approves it');
    expect((out as any).message).toContain('API key not found or not active');
  });

  it('does not hold the sign-in back when Etsy cannot be reached or answers something else', async () => {
    const { service } = build(jest.fn());
    outbound.mockReset().mockRejectedValue(new Error('ETIMEDOUT'));
    expect(await service.verifyCredentials('etsy', 'org1', { ETSY_CLIENT_ID: 'ks', ETSY_CLIENT_SECRET: 'ss' })).toEqual({
      ok: null,
      skipped: 'authorization',
    });
    outbound.mockReset().mockResolvedValue({ status: 503, data: 'down' } as any);
    expect(await service.verifyCredentials('etsy', 'org1', { ETSY_CLIENT_ID: 'ks', ETSY_CLIENT_SECRET: 'ss' })).toEqual({
      ok: null,
      skipped: 'authorization',
    });
  });

  it('has nothing to check before the sign-in for an OAuth adapter without app-key check', async () => {
    outbound.mockReset();
    const { service } = build(jest.fn());
    const out = await service.verifyCredentials('google-search-console', 'org1', {
      GOOGLE_CLIENT_ID: 'id',
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
    expect(etsy.needs).toEqual(['Keystring', 'Shared secret']);
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

  it('on Odoo 19 says the database name is wrong and names the right one, at the root of the address', async () => {
    odooAnswers({ version: ['saas~19', 3, 0, 'final', 0, 'e'], serie: 'saas~19.3', databases: ['binikit-main-12245208'] });
    const out: any = await build().verifyCredentials('odoo', 'org1', creds);
    expect(out.ok).toBe(false);
    expect(out.suggest).toBeUndefined();
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

  it('keeps the old hint and suggestion when Odoo does not tell its version', async () => {
    outbound.mockReset();
    outbound.mockRejectedValue(new Error('ECONNREFUSED'));
    const out: any = await build().verifyCredentials('odoo', 'org1', creds);
    expect(out).toMatchObject({ ok: false, suggest: 'odoo-jsonrpc' });
    expect(out.message).toMatch(/older than 19, or the database name is wrong/);
  });
});

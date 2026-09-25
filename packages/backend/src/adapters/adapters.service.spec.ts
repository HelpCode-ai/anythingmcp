import { BadRequestException } from '@nestjs/common';
import { AdaptersService } from './adapters.service';

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
});

describe('AdaptersService install — a base URL variable without https://', () => {
  function build() {
    const prisma = {
      connector: {
        create: jest.fn().mockResolvedValue({ id: 'c1' }),
        // The import probe looks the connector up; nothing found = no probe.
        findUnique: jest.fn().mockResolvedValue(null),
      },
      mcpTool: { create: jest.fn().mockResolvedValue({}) },
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

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
});

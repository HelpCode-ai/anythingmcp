import { BadRequestException } from '@nestjs/common';
import {
  assertAbsoluteBaseUrl,
  checkBaseUrlValue,
  leadingBaseUrlVariable,
  normalizeBaseUrlVariable,
  normalizeBaseUrlVariables,
} from './base-url-variable.util';
import { listAdapters, getAdapter } from '../adapters/catalog';

describe('leadingBaseUrlVariable', () => {
  it('finds the variable a template starts with', () => {
    expect(leadingBaseUrlVariable('{{SUBSTACK_PUBLICATION_URL}}')).toBe(
      'SUBSTACK_PUBLICATION_URL',
    );
    expect(leadingBaseUrlVariable('{{MAGENTO_BASE_URL}}/rest/default/V1')).toBe(
      'MAGENTO_BASE_URL',
    );
    expect(leadingBaseUrlVariable('{{ SAGE100_URL }}/api/v1/{{SAGE100_COMPANY}}')).toBe(
      'SAGE100_URL',
    );
  });

  it('ignores a variable that is only part of the host', () => {
    expect(leadingBaseUrlVariable('https://{{TENANT}}.weclapp.com/api')).toBeNull();
    expect(leadingBaseUrlVariable('https://api.example.com')).toBeNull();
    expect(leadingBaseUrlVariable(undefined)).toBeNull();
  });
});

describe('checkBaseUrlValue', () => {
  it.each([
    ['https://yourname.substack.com', 'https://yourname.substack.com'],
    ['http://intranet.example.com:8080/api', 'http://intranet.example.com:8080/api'],
    ['HTTPS://Shop.Example.com', 'HTTPS://Shop.Example.com'],
    ['http://nextcloud:8080', 'http://nextcloud:8080'],
  ])('keeps a full http(s) URL as typed: %s', (value, expected) => {
    expect(checkBaseUrlValue(value)).toEqual({ ok: true, value: expected });
  });

  it.each([
    ['yourname.substack.com', 'https://yourname.substack.com'],
    ['  shop.example.com/de  ', 'https://shop.example.com/de'],
    ['erp.example.co.uk:8443', 'https://erp.example.co.uk:8443'],
    ['10.0.0.5:8443', 'https://10.0.0.5:8443'],
    ['//cdn.example.com', 'https://cdn.example.com'],
  ])('adds https:// to a bare host: %s', (value, expected) => {
    expect(checkBaseUrlValue(value)).toEqual({ ok: true, value: expected });
  });

  it.each([
    ['', /empty/],
    ['   ', /empty/],
    ['ftp://files.example.com', /ftp:\/\/.*only https:\/\/ and http:\/\//],
    ['someone@example.com', /e-mail address/],
    ['my shop.example.com', /spaces/],
    ['nextcloud:8080', /type it in full/],
    ['localhost', /type it in full/],
    ['javascript:alert(1)', /not a web address/],
    ['https://', /not a valid web address/],
  ])('refuses %j', (value, reason) => {
    const check = checkBaseUrlValue(value);
    expect(check.ok).toBe(false);
    expect((check as { reason: string }).reason).toMatch(reason);
  });
});

describe('normalizeBaseUrlVariable', () => {
  it('returns the normalised value', () => {
    expect(normalizeBaseUrlVariable('SUBSTACK_PUBLICATION_URL', 'yourname.substack.com')).toBe(
      'https://yourname.substack.com',
    );
  });

  it('names the variable and does not echo the value', () => {
    let caught: unknown;
    try {
      normalizeBaseUrlVariable('SUBSTACK_PUBLICATION_URL', 'someone@example.com');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    const message = (caught as Error).message;
    expect(message).toMatch(
      /^SUBSTACK_PUBLICATION_URL must be a full URL such as https:\/\/example\.com — it looks like an e-mail address/,
    );
    expect(message).not.toContain('someone@example.com');
  });
});

describe('normalizeBaseUrlVariables', () => {
  it('rewrites only the variable the base URL starts with', () => {
    expect(
      normalizeBaseUrlVariables(
        '{{MAGENTO_BASE_URL}}/rest/default/V1',
        { MAGENTO_BASE_URL: 'shop.example.com', MAGENTO_TOKEN: 'abc.def' },
        'REST',
      ),
    ).toEqual({ MAGENTO_BASE_URL: 'https://shop.example.com', MAGENTO_TOKEN: 'abc.def' });
  });

  it('leaves the map alone when the variable is not in it', () => {
    const values = { OTHER: 'x' };
    expect(normalizeBaseUrlVariables('{{URL}}', values, 'REST')).toBe(values);
  });

  it('leaves database connection strings alone', () => {
    const values = { HOST: 'db.internal' };
    expect(normalizeBaseUrlVariables('{{HOST}}', values, 'DATABASE')).toBe(values);
  });

  it('throws for a value that cannot be a URL', () => {
    expect(() =>
      normalizeBaseUrlVariables('{{URL}}/api', { URL: 'not a url' }, 'REST'),
    ).toThrow(/^URL must be a full URL/);
  });
});

describe('assertAbsoluteBaseUrl', () => {
  it('accepts an absolute http(s) URL', () => {
    expect(() =>
      assertAbsoluteBaseUrl({ baseUrl: 'https://yourname.substack.com', connectorType: 'REST' }),
    ).not.toThrow();
  });

  it('does not judge database connection strings', () => {
    expect(() =>
      assertAbsoluteBaseUrl({ baseUrl: 'postgres://db:5432/app', connectorType: 'DATABASE' }),
    ).not.toThrow();
  });

  it('names the variable from a templated base URL and suggests the fix', () => {
    expect(() =>
      assertAbsoluteBaseUrl(
        {
          baseUrl: 'yourname.substack.com',
          connectorType: 'REST',
          template: '{{SUBSTACK_PUBLICATION_URL}}',
          envVars: { SUBSTACK_PUBLICATION_URL: 'yourname.substack.com' },
        },
        'the connector behind substack_list_posts',
      ),
    ).toThrow(
      'SUBSTACK_PUBLICATION_URL must be a full URL such as https://yourname.substack.com, ' +
        'not "yourname.substack.com". The request from the connector behind ' +
        'substack_list_posts was not sent',
    );
  });

  it('finds the variable behind a base URL resolved at install', () => {
    // Catalog installs store the resolved URL, not the template.
    expect(() =>
      assertAbsoluteBaseUrl({
        baseUrl: 'shop.example.com/rest/default/V1',
        connectorType: 'REST',
        template: 'shop.example.com/rest/default/V1',
        envVars: { MAGENTO_TOKEN: 'abc', MAGENTO_BASE_URL: 'shop.example.com' },
      }),
    ).toThrow(/^MAGENTO_BASE_URL must be a full URL such as https:\/\/shop\.example\.com,/);
  });

  it('does not echo a value that is not a host name', () => {
    let message = '';
    try {
      assertAbsoluteBaseUrl({
        baseUrl: 'sk_live_not_a_host_at_all',
        connectorType: 'REST',
        template: '{{API_URL}}',
        envVars: { API_URL: 'sk_live_not_a_host_at_all' },
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/^API_URL must be a full URL such as https:\/\/example\.com/);
    expect(message).not.toContain('sk_live');
  });

  it('falls back to the base URL itself when no variable is involved', () => {
    expect(() =>
      assertAbsoluteBaseUrl({ baseUrl: 'api.example.com/v1', connectorType: 'REST' }),
    ).toThrow(
      /^The base URL of this connector must be a full URL such as https:\/\/api\.example\.com\/v1, not "api\.example\.com\/v1"/,
    );
  });
});

describe('catalog adapters whose base URL is a variable', () => {
  // Every adapter that builds its address from a value the user types must be
  // covered by the check: an HTTP connector whose template starts with the
  // variable, and that variable must be one the install form asks for.
  const leading = listAdapters()
    .map((meta) => getAdapter(meta.slug)!)
    .filter((a) => leadingBaseUrlVariable(a.connector.baseUrl));

  it('includes Substack and the other self-hosted-URL adapters', () => {
    const slugs = leading.map((a) => a.slug);
    expect(slugs).toEqual(expect.arrayContaining(['substack', 'magento', 'wordpress']));
  });

  it.each(leading.map((a) => [a.slug, a] as const))(
    '%s: a bare host gets https://, and the variable is one the form asks for',
    (_slug, adapter) => {
      const name = leadingBaseUrlVariable(adapter.connector.baseUrl)!;
      expect(adapter.requiredEnvVars).toContain(name);
      expect(
        normalizeBaseUrlVariables(
          adapter.connector.baseUrl,
          { [name]: 'service.example.com' },
          adapter.connector.type,
        )[name],
      ).toBe('https://service.example.com');
    },
  );
});

import { ForbiddenException, UnprocessableEntityException } from '@nestjs/common';
import { describeSpecError, normalizeSpecUrl, readRemoteSpec } from './spec-read-error';

describe('readRemoteSpec', () => {
  it('passes the result through', async () => {
    await expect(readRemoteSpec('WSDL', async () => [1, 2])).resolves.toEqual([1, 2]);
  });

  it('turns a parser failure into a 422 with a readable reason', async () => {
    const run = readRemoteSpec('WSDL', async () => {
      throw new Error('Root element of WSDL was <html>. This is likely an authentication issue.');
    });
    await expect(run).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(run).rejects.toThrow(/Could not read the WSDL: the URL returned an HTML page/);
  });

  it('leaves HttpExceptions alone', async () => {
    await expect(
      readRemoteSpec('OpenAPI specification', async () => {
        throw new ForbiddenException('nope');
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('describeSpecError', () => {
  it('names network failures', () => {
    expect(describeSpecError(new Error('getaddrinfo ENOTFOUND api.example'))).toMatch(/could not be resolved/);
    expect(describeSpecError(new Error('connect ECONNREFUSED 10.0.0.1:443'))).toMatch(/refused/);
  });

  it('never echoes a URL, which may carry credentials', () => {
    const reason = describeSpecError(new Error('Bad response from https://x.example/api?token=secret'));
    expect(reason).not.toContain('secret');
    expect(reason).toContain('<url>');
  });

  it('keeps only the first line, capped', () => {
    const reason = describeSpecError(new Error(`${'a'.repeat(500)}\nstack`));
    expect(reason.length).toBeLessThanOrEqual(301);
    expect(reason).not.toContain('stack');
  });
});

describe('normalizeSpecUrl', () => {
  it('trims spaces and adds https:// to a bare host', () => {
    expect(normalizeSpecUrl('docs.ozon.ru/api/performance/swagger.json ')).toBe(
      'https://docs.ozon.ru/api/performance/swagger.json',
    );
    expect(normalizeSpecUrl(' Coinmarketcap.com ')).toBe('https://Coinmarketcap.com');
    expect(normalizeSpecUrl('api.example.com:8443/openapi.yaml')).toBe('https://api.example.com:8443/openapi.yaml');
  });

  it('keeps addresses that already have a scheme', () => {
    expect(normalizeSpecUrl('  http://api.example.com/spec.json')).toBe('http://api.example.com/spec.json');
    expect(normalizeSpecUrl('https://api.example.com/spec.json')).toBe('https://api.example.com/spec.json');
  });

  it('leaves paths, single words and text with spaces alone', () => {
    expect(normalizeSpecUrl('/openapi.json')).toBe('/openapi.json');
    expect(normalizeSpecUrl('localhost:8080/spec')).toBe('localhost:8080/spec');
    expect(normalizeSpecUrl('not a url.com')).toBe('not a url.com');
    expect(normalizeSpecUrl('')).toBe('');
  });
});

describe('describeSpecError for an incomplete address', () => {
  it('says what to type instead of naming the SSRF guard', () => {
    const reason = describeSpecError(new Error("SSRF guard: invalid URL 'Coinmarketcap'"));
    expect(reason).toMatch(/full address, for example https:\/\//);
    expect(reason).not.toMatch(/SSRF/);
  });
});

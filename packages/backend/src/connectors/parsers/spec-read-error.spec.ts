import { ForbiddenException, UnprocessableEntityException } from '@nestjs/common';
import { describeSpecError, readRemoteSpec } from './spec-read-error';

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

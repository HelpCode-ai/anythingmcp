// Licensed under the AnythingMCP Commercial License, see packages/backend/src/ee/LICENSE.
import { Readable } from 'node:stream';
import { parseListDate } from './ftp.driver';
import { sshFingerprint } from './sftp.driver';
import { classifyNetworkError, limitStream, remotePath, safeRel } from './source.types';

describe('source helpers', () => {
  it('keeps paths inside the root', () => {
    expect(safeRel('a/./b//c')).toBe('a/b/c');
    expect(() => safeRel('a/../../etc')).toThrow();
    expect(() => safeRel('a\u0000b')).toThrow();
    expect(remotePath('/Lieferanten/', 'Nordtor/x.pdf')).toBe('/Lieferanten/Nordtor/x.pdf');
    expect(remotePath('/', '')).toBe('/');
  });

  it('maps network errors to the wizard error kinds', () => {
    expect(classifyNetworkError(Object.assign(new Error('getaddrinfo ENOTFOUND x'), { code: 'ENOTFOUND' })).kind).toBe('dns');
    expect(classifyNetworkError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })).kind).toBe('unreachable');
    expect(classifyNetworkError(new Error('530 Login incorrect.')).kind).toBe('auth');
    expect(classifyNetworkError(Object.assign(new Error('SSRF guard: address 10.0.0.1 is not a public IP'), { name: 'SsrfBlockedError' })).kind).toBe('private_address');
  });

  it('formats SSH fingerprints like ssh-keygen', () => {
    expect(sshFingerprint(Buffer.from('key'))).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
  });

  it('parses FTP LIST dates', () => {
    expect(parseListDate('Oct 09 2024')?.toISOString()).toBe('2024-10-09T00:00:00.000Z');
    expect(parseListDate('10-09-24 02:30PM')?.toISOString()).toBe('2024-10-09T14:30:00.000Z');
    expect(parseListDate('garbage')).toBeNull();
  });

  it('stops a stream that exceeds its byte budget', async () => {
    const s = limitStream(Readable.from([Buffer.alloc(600), Buffer.alloc(600)]), 1000);
    await expect((async () => { for await (const _ of s) { /* drain */ } })()).rejects.toThrow(/larger than/);
    const ok = limitStream(Readable.from([Buffer.alloc(10)]), 1000);
    let n = 0;
    for await (const c of ok) n += (c as Buffer).length;
    expect(n).toBe(10);
  });
});

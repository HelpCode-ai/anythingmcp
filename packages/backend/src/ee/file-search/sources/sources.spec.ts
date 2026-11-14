// Licensed under the AnythingMCP Commercial License, see packages/backend/src/ee/LICENSE.
import * as net from 'node:net';
import { Readable } from 'node:stream';
import { FtpDriver, parseListDate } from './ftp.driver';
import { S3Driver } from './s3.driver';
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

describe('source drivers and the SSRF guard', () => {
  const base = { include: [], exclude: [], maxDepth: 20, maxConnections: 1, toolPrefix: 'x', rootPath: '' } as any;
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.SSRF_GUARD = 'enabled';
    delete process.env.SSRF_ALLOW_LOCALHOST;
    delete process.env.SSRF_ALLOW_PRIVATE;
    process.env.SSRF_ALLOWED_HOSTS = '';
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it.each(['http://169.254.169.254', 'http://127.0.0.1:9000', 'http://[::1]:9000', 'http://10.0.0.5'])(
    'refuses an S3 endpoint on a non-public literal IP (%s)',
    async (url) => {
      const err = await new S3Driver()
        .connect({ ...base, protocol: 's3', url, bucket: 'b', region: 'us-east-1' }, { accessKeyId: 'a', secretAccessKey: 'b' } as any, { cloud: true, test: true, timeoutMs: 1000 })
        .catch((e) => e);
      expect(err.kind).toBe('private_address');
    },
  );

  it('opens passive data connections to the control host only, whatever PASV announces', async () => {
    process.env.SSRF_ALLOWED_HOSTS = 'localhost';
    let dataConnections = 0;
    const data = net.createServer((s) => {
      s.on('error', () => undefined);
      dataConnections++;
      s.end('-rw-r--r-- 1 u g 5 Jan 01 2026 a.txt\r\n');
    });
    await new Promise<void>((r) => data.listen(0, '127.0.0.1', r));
    const port = (data.address() as net.AddressInfo).port;
    const control = net.createServer((c) => {
      c.on('error', () => undefined);
      c.write('220 test\r\n');
      c.on('data', (b) => {
        for (const line of b.toString().split('\r\n').filter(Boolean)) {
          const cmd = line.split(' ')[0].toUpperCase();
          if (cmd === 'USER') c.write('331 pw\r\n');
          else if (cmd === 'PASS') c.write('230 ok\r\n');
          else if (cmd === 'EPSV') c.write('500 no\r\n');
          else if (cmd === 'PASV') c.write(`227 Entering Passive Mode (10,9,9,9,${port >> 8},${port & 255})\r\n`);
          else if (cmd === 'LIST' || cmd === 'MLSD') {
            c.write('150 here\r\n');
            setTimeout(() => c.write('226 done\r\n'), 100);
          } else if (cmd === 'QUIT') c.end('221 bye\r\n');
          else c.write('200 ok\r\n');
        }
      });
    });
    await new Promise<void>((r) => control.listen(0, '127.0.0.1', r));
    try {
      const { session } = await new FtpDriver().connect(
        { ...base, protocol: 'ftp', host: 'localhost', port: (control.address() as net.AddressInfo).port, username: 'u', allowPlainFtp: true },
        { password: 'x' } as any,
        { cloud: true, test: true, timeoutMs: 3000 },
      );
      const entries = await session.list('');
      await session.close();
      expect(entries.map((e) => e.name)).toEqual(['a.txt']);
      expect(dataConnections).toBe(1);
    } finally {
      control.close();
      data.close();
    }
  });

  it('lists a folder after CWD, for servers that ignore the path in LIST', async () => {
    process.env.SSRF_ALLOWED_HOSTS = 'localhost';
    let cwd = '/';
    let dataSock: net.Socket | null = null;
    const data = net.createServer((sock) => {
      sock.on('error', () => undefined);
      dataSock = sock;
    });
    await new Promise<void>((r) => data.listen(0, '127.0.0.1', r));
    const port = (data.address() as net.AddressInfo).port;
    const control = net.createServer((c) => {
      c.on('error', () => undefined);
      c.write('220 test\r\n');
      c.on('data', (b) => {
        for (const line of b.toString().split('\r\n').filter(Boolean)) {
          const [cmd, ...rest] = line.split(' ');
          const arg = rest.join(' ');
          const up = cmd.toUpperCase();
          if (up === 'USER') c.write('331 pw\r\n');
          else if (up === 'PASS') c.write('230 ok\r\n');
          else if (up === 'CWD') {
            cwd = arg;
            c.write('250 ok\r\n');
          } else if (up === 'EPSV') c.write('500 no\r\n');
          else if (up === 'PASV') c.write(`227 Entering Passive Mode (127,0,0,1,${port >> 8},${port & 255})\r\n`);
          else if (up === 'LIST' || up === 'MLSD') {
            // Like a Fritz!Box: the path argument is ignored, the current folder is listed.
            const listing = cwd === '/docs' ? '-rw-r--r-- 1 u g 5 Jan 01 2026 inner.txt\r\n' : 'drwxr-xr-x 1 u g 0 Jan 01 2026 docs\r\n';
            c.write('150 here\r\n');
            setTimeout(() => {
              dataSock?.end(listing);
              setTimeout(() => c.write('226 done\r\n'), 50);
            }, 50);
          } else if (up === 'QUIT') c.end('221 bye\r\n');
          else c.write('200 ok\r\n');
        }
      });
    });
    await new Promise<void>((r) => control.listen(0, '127.0.0.1', r));
    try {
      const { session } = await new FtpDriver().connect(
        { ...base, protocol: 'ftp', host: 'localhost', port: (control.address() as net.AddressInfo).port, username: 'u', rootPath: '/docs', allowPlainFtp: true },
        { password: 'x' } as any,
        { cloud: true, test: true, timeoutMs: 3000 },
      );
      expect((await session.list('')).map((e) => e.name)).toEqual(['inner.txt']);
      await session.close();
    } finally {
      control.close();
      data.close();
    }
  });
});


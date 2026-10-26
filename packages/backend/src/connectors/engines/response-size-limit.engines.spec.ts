import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { RestEngine } from './rest.engine';
import { GraphqlEngine } from './graphql.engine';
import { SoapEngine } from './soap.engine';
import {
  RESPONSE_TOO_LARGE_CODE,
  ResponseTooLargeError,
} from '../../common/response-size-limit';

/**
 * The tool response size limit (TOOL_MAX_RESPONSE_BYTES) against a real HTTP
 * server, through each engine that reads an upstream body with axios. A body
 * over the limit must fail with our own error, not load.
 */
describe('tool response size limit in the connector engines', () => {
  let server: Server;
  let baseUrl: string;
  /** Size of the `filler` string in the next response. */
  let fillerBytes = 0;
  let sentBytes = 0;
  const saved = process.env.TOOL_MAX_RESPONSE_BYTES;

  const jsonOf = (filler: string, path: string): string => {
    if (path.startsWith('/graphql')) return JSON.stringify({ data: { items: filler } });
    // Odoo's JSON-RPC envelope, as `odoo_search_read` gets it.
    return JSON.stringify({ jsonrpc: '2.0', id: 1, result: [{ id: 1, name: filler }] });
  };

  beforeAll(async () => {
    server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        const filler = 'x'.repeat(fillerBytes);
        const path = req.url ?? '/';
        if (path.startsWith('/soap')) {
          res.setHeader('Content-Type', 'text/xml; charset=utf-8');
          const xml =
            '<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">' +
            `<soap:Body><GetUserResponse><name>${filler}</name></GetUserResponse></soap:Body></soap:Envelope>`;
          sentBytes = Buffer.byteLength(xml);
          res.end(xml);
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        const body = jsonOf(filler, path);
        sentBytes = Buffer.byteLength(body);
        if (path.startsWith('/gzip')) {
          res.setHeader('Content-Encoding', 'gzip');
          res.end(gzipSync(body));
          return;
        }
        // Chunked, with no Content-Length: the limit must hold on the bytes
        // read, not on what a header announces.
        const chunk = 64 * 1024;
        for (let i = 0; i < body.length; i += chunk) res.write(body.slice(i, i + chunk));
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.TOOL_MAX_RESPONSE_BYTES;
    else process.env.TOOL_MAX_RESPONSE_BYTES = saved;
  });

  describe('RestEngine (JSON-RPC, as Odoo uses it)', () => {
    const engine = new RestEngine({} as any, {} as any);
    const call = (path = '/jsonrpc') =>
      engine.execute(
        { baseUrl, authType: 'NONE' },
        { method: 'POST', path, bodyMapping: { jsonrpc: '2.0' } },
        {},
      );

    it('returns a response under the default 10 MB limit', async () => {
      delete process.env.TOOL_MAX_RESPONSE_BYTES;
      fillerBytes = 1024 * 1024;
      const body = (await call()) as { result: Array<{ name: string }> };
      expect(body.result[0].name).toHaveLength(fillerBytes);
    });

    it('fails a response over the default 10 MB limit with our own error', async () => {
      delete process.env.TOOL_MAX_RESPONSE_BYTES;
      fillerBytes = 11 * 1024 * 1024;
      const err = await call().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ResponseTooLargeError);
      expect((err as ResponseTooLargeError).code).toBe(RESPONSE_TOO_LARGE_CODE);
      expect((err as ResponseTooLargeError).limitBytes).toBe(10 * 1024 * 1024);
      expect((err as Error).message).toMatch(/larger than 10 MB, the limit for one tool call/);
      expect((err as Error).message).toMatch(/Narrow the request/);
    });

    it('takes the limit from TOOL_MAX_RESPONSE_BYTES', async () => {
      process.env.TOOL_MAX_RESPONSE_BYTES = String(64 * 1024);
      fillerBytes = 100 * 1024;
      const err = await call().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ResponseTooLargeError);
      expect((err as ResponseTooLargeError).limitBytes).toBe(64 * 1024);
      expect((err as Error).message).toMatch(/larger than 64 KB/);

      // The same body passes once the limit is raised.
      process.env.TOOL_MAX_RESPONSE_BYTES = String(1024 * 1024);
      await expect(call()).resolves.toMatchObject({ jsonrpc: '2.0' });
    });

    it('lets a body exactly at the limit through', async () => {
      fillerBytes = 10_000;
      await call();
      process.env.TOOL_MAX_RESPONSE_BYTES = String(sentBytes);
      await expect(call()).resolves.toMatchObject({ jsonrpc: '2.0' });
      process.env.TOOL_MAX_RESPONSE_BYTES = String(sentBytes - 1);
      await expect(call()).rejects.toBeInstanceOf(ResponseTooLargeError);
    });

    it('counts the decompressed bytes of a gzip body', async () => {
      process.env.TOOL_MAX_RESPONSE_BYTES = String(64 * 1024);
      // About 1 MB of text that gzips to a few KB.
      fillerBytes = 1024 * 1024;
      await expect(call('/gzip')).rejects.toBeInstanceOf(ResponseTooLargeError);
    });
  });

  describe('GraphqlEngine', () => {
    const engine = new GraphqlEngine({} as any, {} as any, {} as any);
    const call = () =>
      engine.execute(
        { baseUrl: `${baseUrl}/graphql`, authType: 'NONE' },
        { method: 'query', path: '{ items }' },
        {},
      );

    it('returns a response under the limit and fails one over it', async () => {
      process.env.TOOL_MAX_RESPONSE_BYTES = String(64 * 1024);
      fillerBytes = 1024;
      await expect(call()).resolves.toEqual({ items: 'x'.repeat(1024) });
      fillerBytes = 100 * 1024;
      await expect(call()).rejects.toBeInstanceOf(ResponseTooLargeError);
    });
  });

  describe('SoapEngine', () => {
    const engine = new SoapEngine();
    const call = () =>
      engine.execute(
        { baseUrl: `${baseUrl}/soap`, authType: 'NONE' },
        {
          method: 'GetUser',
          path: 'BasicHttpBinding_IService',
          soapAction: 'http://tempuri.org/IService/GetUser',
          endpoint: `${baseUrl}/soap`,
          targetNamespace: 'http://tempuri.org/',
          paramOrder: ['userId'],
        } as any,
        { userId: '1' },
      );

    it('returns a response under the limit and fails one over it', async () => {
      process.env.TOOL_MAX_RESPONSE_BYTES = String(64 * 1024);
      fillerBytes = 1024;
      await expect(call()).resolves.toBeDefined();
      fillerBytes = 100 * 1024;
      const err = await call().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ResponseTooLargeError);
      expect((err as Error).message).toMatch(/larger than 64 KB/);
    });
  });
});

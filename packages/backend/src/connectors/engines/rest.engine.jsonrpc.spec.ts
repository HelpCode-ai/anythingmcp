import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { JsonRpcError, RestEngine, assertNotJsonRpcError } from './rest.engine';

/**
 * JSON-RPC servers answer errors with HTTP 200. Odoo's and Zabbix's real
 * shapes, as logged in production (Oct 2026), must surface as errors.
 */
describe('assertNotJsonRpcError', () => {
  it("raises Odoo's error with the message from error.data, not the traceback", () => {
    const odoo = {
      jsonrpc: '2.0',
      id: null,
      error: {
        code: 200,
        message: 'Odoo Server Error',
        data: { name: 'odoo.exceptions.AccessDenied', debug: 'Traceback (most recent call last): ...', message: 'Access Denied' },
      },
    };
    expect(() => assertNotJsonRpcError(odoo)).toThrow(new JsonRpcError('JSON-RPC error 200: Odoo Server Error: Access Denied', 200));
    expect(() => assertNotJsonRpcError(odoo)).not.toThrow(/Traceback/);
  });

  it("raises Zabbix's error, whose detail is a plain string", () => {
    const zabbix = { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Invalid params.', data: 'Not authorised.' } };
    expect(() => assertNotJsonRpcError(zabbix)).toThrow('JSON-RPC error -32602: Invalid params.: Not authorised.');
  });

  it('lets results, ordinary bodies and batch arrays through', () => {
    expect(() => assertNotJsonRpcError({ jsonrpc: '2.0', id: 1, result: [] })).not.toThrow();
    expect(() => assertNotJsonRpcError({ jsonrpc: '2.0', id: 1, result: false })).not.toThrow();
    expect(() => assertNotJsonRpcError({ error: 'not found' })).not.toThrow();
    expect(() => assertNotJsonRpcError({ error: { message: 'x' } })).not.toThrow();
    expect(() => assertNotJsonRpcError([{ jsonrpc: '2.0', error: { code: 1 } }])).not.toThrow();
    expect(() => assertNotJsonRpcError('text')).not.toThrow();
    expect(() => assertNotJsonRpcError(null)).not.toThrow();
  });
});

describe('RestEngine on a JSON-RPC endpoint', () => {
  let server: Server;
  let baseUrl: string;
  let reply: unknown;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(reply));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const engine = new RestEngine({} as any, {} as any);
  const call = () =>
    engine.execute({ baseUrl, authType: 'NONE' }, { method: 'POST', path: '/jsonrpc', bodyMapping: { jsonrpc: '2.0' } }, {});

  it('rejects an HTTP 200 that carries an error', async () => {
    reply = { jsonrpc: '2.0', id: 1, error: { code: 200, message: 'Odoo Server Error', data: { message: 'Access Denied' } } };
    await expect(call()).rejects.toThrow('Access Denied');
  });

  it('returns the envelope of a successful call unchanged', async () => {
    reply = { jsonrpc: '2.0', id: 1, result: [{ id: 7 }] };
    await expect(call()).resolves.toEqual(reply);
  });
});

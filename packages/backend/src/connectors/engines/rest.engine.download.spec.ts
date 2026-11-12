import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';

const fetchOutbound = jest.fn();
jest.mock('../../common/outbound-fetch.util', () => ({
  ...jest.requireActual('../../common/outbound-fetch.util'),
  fetchOutbound: (...args: unknown[]) => fetchOutbound(...args),
}));

import { RestEngine } from './rest.engine';

/**
 * `endpointMapping.download` end to end: the API call goes out with the
 * connector's auth, the link it returns is fetched without it, and the tool
 * answers with parsed rows (Libredesk #268, Amazon report documents).
 */
describe('RestEngine endpointMapping.download', () => {
  const LINK = 'https://tortuga-prod-na.s3-external-1.amazonaws.com/doc?X-Amz-Signature=abc';
  let server: Server;
  let baseUrl: string;
  const seenAuth: Array<string | undefined> = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      seenAuth.push(req.headers['x-api-key'] as string | undefined);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ reportDocumentId: 'DOC1', url: LINK, compressionAlgorithm: 'GZIP' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('fetches the returned link without credentials and returns rows', async () => {
    fetchOutbound.mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'text/plain' },
      body: gzipSync('sku\tqty\nA\t1\nB\t2\n'),
      finalUrl: LINK,
    });
    const engine = new RestEngine({} as any, {} as any);
    const body = await engine.execute(
      { baseUrl, authType: 'API_KEY', authConfig: { headerName: 'x-api-key', apiKey: 'secret-key' } },
      {
        method: 'GET',
        path: '/reports/2021-06-30/documents/{reportDocumentId}',
        download: {
          urlField: 'url',
          compressionField: 'compressionAlgorithm',
          allowedHosts: ['amazonaws.com'],
          filterColumn: '$filterColumn',
          filterValue: '$filterValue',
        },
      },
      { reportDocumentId: 'DOC1', filterColumn: 'sku', filterValue: 'B' },
    );
    expect(seenAuth).toEqual(['secret-key']);
    expect(fetchOutbound).toHaveBeenCalledTimes(1);
    expect(fetchOutbound.mock.calls[0][0]).toBe(LINK);
    expect(JSON.stringify(fetchOutbound.mock.calls[0][1])).not.toContain('secret-key');
    expect(body).toMatchObject({ format: 'tsv', totalRows: 2, matchedRows: 1, rows: [{ sku: 'B', qty: '2' }] });
  });

  it('leaves tools without the block unchanged', async () => {
    fetchOutbound.mockClear();
    const engine = new RestEngine({} as any, {} as any);
    const body = await engine.execute({ baseUrl, authType: 'NONE' }, { method: 'GET', path: '/x' }, {});
    expect(body).toEqual({ reportDocumentId: 'DOC1', url: LINK, compressionAlgorithm: 'GZIP' });
    expect(fetchOutbound).not.toHaveBeenCalled();
  });
});

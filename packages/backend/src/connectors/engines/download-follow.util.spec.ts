import { gzipSync } from 'zlib';
import {
  DOWNLOAD_MAX_LIMIT,
  followDownload,
  hostAllowed,
  parseDelimited,
  validateDownloadConfig,
  type DownloadFollowConfig,
} from './download-follow.util';

const config: DownloadFollowConfig = {
  urlField: 'url',
  compressionField: 'compressionAlgorithm',
  allowedHosts: ['amazonaws.com'],
  offset: '$offset',
  limit: '$limit',
  columns: '$columns',
  filterColumn: '$filterColumn',
  filterValue: '$filterValue',
};

const LINK = 'https://tortuga-prod-na.s3-external-1.amazonaws.com/doc?X-Amz-Signature=abc';
const TSV = 'sku\tasin\tprice\tquantity\nA-1\tB001\t9.99\t3\nA-2\tB002\t19.99\t0\nA-3\tB003\t5.00\t7\n';

function fakeFetch(body: Buffer, contentType = 'text/plain') {
  return jest.fn().mockResolvedValue({ status: 200, headers: { 'content-type': contentType }, body, finalUrl: LINK });
}

describe('followDownload', () => {
  it('gunzips a GZIP document and pages its tab-separated rows', async () => {
    const fetch = fakeFetch(gzipSync(Buffer.from(TSV)));
    const out = await followDownload({ url: LINK, compressionAlgorithm: 'GZIP' }, config, { limit: 2 }, fetch as any);
    expect(fetch).toHaveBeenCalledWith(LINK, expect.objectContaining({ maxBytes: expect.any(Number) }));
    // No connector credentials: only the URL and the limits are passed.
    expect(Object.keys(fetch.mock.calls[0][1])).toEqual(['maxBytes', 'timeoutMs']);
    expect(out).toMatchObject({
      format: 'tsv',
      columns: ['sku', 'asin', 'price', 'quantity'],
      totalRows: 3,
      matchedRows: 3,
      returned: 2,
      nextOffset: 2,
      rows: [
        { sku: 'A-1', asin: 'B001', price: '9.99', quantity: '3' },
        { sku: 'A-2', asin: 'B002', price: '19.99', quantity: '0' },
      ],
    });
  });

  it('detects gzip by its magic bytes when the marker is missing', async () => {
    const out = await followDownload({ url: LINK }, config, {}, fakeFetch(gzipSync(Buffer.from(TSV))) as any);
    expect(out.totalRows).toBe(3);
  });

  it('filters by a column (case-insensitive, several values) and picks columns', async () => {
    const out = await followDownload(
      { url: LINK },
      config,
      { filterColumn: 'SKU', filterValue: 'a-1, A-3', columns: 'sku,quantity', offset: 0 },
      fakeFetch(Buffer.from(TSV)) as any,
    );
    expect(out).toMatchObject({
      matchedRows: 2,
      nextOffset: null,
      rows: [
        { sku: 'A-1', quantity: '3' },
        { sku: 'A-3', quantity: '7' },
      ],
    });
  });

  it('names the columns when a filter or column does not exist', async () => {
    await expect(
      followDownload({ url: LINK }, config, { filterColumn: 'seller-sku', filterValue: 'x' }, fakeFetch(Buffer.from(TSV)) as any),
    ).rejects.toThrow(/Columns: sku, asin, price, quantity/);
    await expect(
      followDownload({ url: LINK }, config, { columns: 'nope' }, fakeFetch(Buffer.from(TSV)) as any),
    ).rejects.toThrow(/Columns not in this file: nope/);
  });

  it('caps the page size', async () => {
    const out = await followDownload({ url: LINK }, config, { limit: 100000 }, fakeFetch(Buffer.from(TSV)) as any);
    expect(out.returned).toBe(3);
    expect(DOWNLOAD_MAX_LIMIT).toBe(500);
  });

  it('returns a JSON document whole', async () => {
    const out = await followDownload({ url: LINK }, config, {}, fakeFetch(Buffer.from('{"a":[1,2]}'), 'application/json') as any);
    expect(out).toEqual({ format: 'json', sizeBytes: 11, data: { a: [1, 2] } });
  });

  it('decodes a Cp1252 document', async () => {
    const latin = Buffer.from([0x73, 0x6b, 0x75, 0x0a, 0x43, 0x61, 0x66, 0xe9, 0x0a]); // "sku\nCafé\n"
    const out = await followDownload({ url: LINK }, { ...config, format: 'tsv' }, {}, fakeFetch(latin, 'text/plain;charset=Cp1252') as any);
    expect(out.rows).toEqual([{ sku: 'Café' }]);
  });

  it('refuses links that are not https or not on an allowed host', async () => {
    const fetch = fakeFetch(Buffer.from(TSV));
    await expect(followDownload({ url: 'http://x.amazonaws.com/a' }, config, {}, fetch as any)).rejects.toThrow(/not https/);
    await expect(followDownload({ url: 'https://evil.example/a' }, config, {}, fetch as any)).rejects.toThrow(/does not allow/);
    await expect(followDownload({ url: 'https://amazonaws.com.evil.example/a' }, config, {}, fetch as any)).rejects.toThrow(/does not allow/);
    await expect(followDownload({}, config, {}, fetch as any)).rejects.toThrow(/no download link/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('stops a gzip bomb at the decompressed cap', async () => {
    const bomb = gzipSync(Buffer.alloc(70 * 1024 * 1024, 0x41));
    await expect(followDownload({ url: LINK }, config, {}, fakeFetch(bomb) as any)).rejects.toThrow(/larger than 64 MB/);
  });
});

describe('download helpers', () => {
  it('matches hosts and their subdomains only', () => {
    expect(hostAllowed('tortuga-prod-eu.s3-eu-west-1.amazonaws.com', ['amazonaws.com'])).toBe(true);
    expect(hostAllowed('amazonaws.com', ['.amazonaws.com'])).toBe(true);
    expect(hostAllowed('notamazonaws.com', ['amazonaws.com'])).toBe(false);
  });

  it('parses quoted CSV', () => {
    expect(parseDelimited('a,b\n"x, y","say ""hi"""\r\n', ',')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
    ]);
  });

  it('validates the stored block', () => {
    expect(validateDownloadConfig(config)).toBeNull();
    expect(validateDownloadConfig({ urlField: 'url' })).toMatch(/allowedHosts/);
    expect(validateDownloadConfig({ urlField: 'url', allowedHosts: ['a'], format: 'xml' })).toMatch(/format/);
  });
});

import { diagnoseOdooJson2NotFound, odooDatabaseHint, odooOrigin } from './odoo-database-hint';
import { outboundRequest } from '../common/outbound-http';

jest.mock('../common/outbound-http', () => ({ outboundRequest: jest.fn() }));
const request = outboundRequest as jest.MockedFunction<typeof outboundRequest>;

// What Odoo.sh answered for a connector whose database was the subdomain.
const JSONRPC_ERROR =
  'JSON-RPC error 200: Odoo Server Error: connection to server at "192.168.1.1", port 5432 failed: ' +
  'FATAL:  database "arelleproducts-limited" does not exist';

describe('odooDatabaseHint', () => {
  beforeEach(() => request.mockReset());

  it('names the database the address serves when the entered one does not exist', async () => {
    request.mockResolvedValue({ data: { result: ['scottandrews1-arelle-products-limited-main-12833303'] } } as any);

    const hint = await odooDatabaseHint(
      'odoo-jsonrpc',
      JSONRPC_ERROR,
      'https://arelleproducts-limited.odoo.com/',
      'arelleproducts-limited',
    );

    expect(hint).toBe(
      'This Odoo\'s database is called "scottandrews1-arelle-products-limited-main-12833303": enter that as the database name.',
    );
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        url: 'https://arelleproducts-limited.odoo.com/web/database/list',
      }),
    );
  });

  it('works for the JSON-2 adapter, whose 404 hint mentions the database name', async () => {
    request.mockResolvedValue({ data: { result: ['binikit-main-12245208'] } } as any);
    const hint = await odooDatabaseHint(
      'odoo',
      'This Odoo has no JSON-2 API: it is older than 19, or the database name is wrong. (404)',
      'https://binikit.odoo.com',
      'binikit',
    );
    expect(hint).toContain('"binikit-main-12245208"');
  });

  it('lists several databases when the server has more than one', async () => {
    request.mockResolvedValue({ data: { result: ['prod', 'staging', 'test'] } } as any);
    const hint = await odooDatabaseHint('odoo-jsonrpc', JSONRPC_ERROR, 'https://erp.example.com', 'wrong');
    expect(hint).toBe('This Odoo serves these databases: "prod", "staging", "test". Enter the one you use as the database name.');
  });

  it('says nothing for another adapter, another error, or when the list is refused', async () => {
    expect(await odooDatabaseHint('weclapp', JSONRPC_ERROR, 'https://x.weclapp.com', 'x')).toBeUndefined();
    expect(
      await odooDatabaseHint('odoo-jsonrpc', 'JSON-RPC error 200: Odoo Server Error: Access Denied', 'https://erp.example.com', 'prod'),
    ).toBeUndefined();
    expect(request).not.toHaveBeenCalled();

    request.mockResolvedValue({ data: { error: { message: 'Access Denied' } } } as any);
    expect(await odooDatabaseHint('odoo-jsonrpc', JSONRPC_ERROR, 'https://erp.example.com', 'prod')).toBeUndefined();

    request.mockRejectedValue(new Error('SSRF guard: blocked'));
    expect(await odooDatabaseHint('odoo-jsonrpc', JSONRPC_ERROR, 'https://erp.example.com', 'prod')).toBeUndefined();
  });

  it('does not suggest the name that was already entered', async () => {
    request.mockResolvedValue({ data: { result: ['prod'] } } as any);
    expect(await odooDatabaseHint('odoo-jsonrpc', JSONRPC_ERROR, 'https://erp.example.com', 'prod')).toBeUndefined();
  });

  it('asks /web/database/list at the root for the JSON-2 adapter, not under /json/2', async () => {
    // The JSON-2 adapter's base URL is {{ODOO_URL}}/json/2, and
    // /json/2/web/database/list answers 404: no name was ever suggested.
    request.mockResolvedValue({ data: { result: ['binikit-main-12245208'] } } as any);
    const hint = await odooDatabaseHint(
      'odoo',
      'This Odoo has no JSON-2 API: it is older than 19, or the database name is wrong. (404)',
      'https://binikit.odoo.com/json/2',
      'binikit',
    );
    expect(hint).toContain('"binikit-main-12245208"');
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://binikit.odoo.com/web/database/list' }),
    );
  });
});

describe('odooOrigin', () => {
  it("drops the JSON-2 path, where Odoo's web routes are not served", () => {
    expect(odooOrigin('https://binikit.odoo.com/json/2')).toBe('https://binikit.odoo.com');
    expect(odooOrigin('https://erp.example.com:8069/')).toBe('https://erp.example.com:8069');
  });
});

describe('diagnoseOdooJson2NotFound', () => {
  beforeEach(() => request.mockReset());

  const version = (info: unknown[], serie: string) =>
    ({ status: 200, data: { result: { server_version_info: info, server_serie: serie } } }) as any;

  it('offers JSON-RPC below 19, for a release and for Odoo Online', async () => {
    request.mockResolvedValueOnce(version([18, 0, 0, 'final', 0, ''], '18.0'));
    expect(await diagnoseOdooJson2NotFound('https://erp.example.com/json/2', 'prod')).toMatchObject({
      suggest: 'odoo-jsonrpc',
      message: expect.stringContaining('version 18.0, older than 19'),
    });

    request.mockResolvedValueOnce(version(['saas~18', 4, 0, 'final', 0, 'e'], 'saas~18.4'));
    expect((await diagnoseOdooJson2NotFound('https://acme.odoo.com/json/2', 'acme'))?.suggest).toBe('odoo-jsonrpc');
  });

  it('on 19 says the database name is wrong, and where to find it when there is no other name to offer', async () => {
    request
      .mockResolvedValueOnce(version([19, 0, 0, 'final', 0, 'e'], '19.0'))
      .mockResolvedValueOnce({ data: { result: ['acme'] } } as any);
    const v19 = await diagnoseOdooJson2NotFound('https://acme.odoo.com/json/2', 'acme');
    expect(v19?.suggest).toBeUndefined();
    expect(v19?.message).toMatch(/database name "acme" is wrong.*\/web\/database\/selector/);
  });

  it("recognises Odoo Online's typo page", async () => {
    request.mockResolvedValueOnce({
      status: 404,
      data: '<html><body><script>window.location = `https://www.odoo.com/typo?domain=nope.odoo.com`;</script></body></html>',
    } as any);
    const out = await diagnoseOdooJson2NotFound('https://nope.odoo.com/json/2', 'nope');
    expect(out?.message).toMatch(/not an Odoo database: Odoo has no database at nope\.odoo\.com/);
    expect(out?.suggest).toBeUndefined();
  });

  it('gives up (undefined) when the answer is not an Odoo version', async () => {
    request.mockResolvedValueOnce({ status: 404, data: '<html>Not Found</html>' } as any);
    expect(await diagnoseOdooJson2NotFound('https://example.com/json/2', 'x')).toBeUndefined();
    request.mockRejectedValueOnce(new Error('SSRF guard: blocked'));
    expect(await diagnoseOdooJson2NotFound('https://10.0.0.1/json/2', 'x')).toBeUndefined();
  });
});

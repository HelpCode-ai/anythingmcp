import { odooDatabaseHint } from './odoo-database-hint';
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
});

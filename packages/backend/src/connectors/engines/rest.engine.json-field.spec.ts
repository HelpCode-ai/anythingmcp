import axios from 'axios';
import { RestEngine } from './rest.engine';
import { OAuth2TokenService } from './oauth2-token.service';
import { LoginTokenService } from './login-token.service';

// The callable default export is mocked; every real static (AxiosError,
// isAxiosError, create, …) is kept so the engine's helpers behave as in prod.
jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const mocked = jest.fn();
  return {
    __esModule: true,
    ...actual,
    default: Object.assign(mocked, actual.default, { __actual: actual.default }),
  };
});
jest.mock('../../common/ssrf.util', () => ({
  ...jest.requireActual('../../common/ssrf.util'),
  assertSafeOutboundUrl: jest.fn().mockResolvedValue(undefined),
}));

const mockedAxios = axios as unknown as jest.Mock;
const config = { baseUrl: 'https://api.example.com', authType: 'NONE' };

async function sent(mapping: Record<string, unknown>, params: Record<string, unknown>) {
  mockedAxios.mockResolvedValue({ data: { status: 'SUCCESS' }, headers: {} });
  await new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    config,
    { method: 'POST', path: '/connector.php', ...mapping } as any,
    params,
  );
  return mockedAxios.mock.calls[0][0];
}

beforeEach(() => mockedAxios.mockReset());

describe('RestEngine __json marker', () => {
  it('sends a form field as the JSON text of its resolved object, dropping omitted arguments', async () => {
    const req = await sent(
      {
        bodyEncoding: 'form-urlencoded',
        bodyMapping: {
          method: 'getOrders',
          parameters: { __json: { order_id: '$order_id', status_id: '$status_id', get_unconfirmed_orders: '$unconfirmed' } },
        },
      },
      { order_id: 42, unconfirmed: false },
    );
    const form = new URLSearchParams(req.data);
    expect(form.get('method')).toBe('getOrders');
    expect(JSON.parse(form.get('parameters')!)).toEqual({ order_id: 42, get_unconfirmed_orders: false });
    expect([...form.keys()]).toEqual(['method', 'parameters']);
    expect(req.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
  });

  it('percent-encodes the JSON text, so & + = and non-ASCII survive', async () => {
    const req = await sent(
      { bodyEncoding: 'form-urlencoded', bodyMapping: { parameters: { __json: { filter_name: '$name' } } } },
      { name: 'A&B + C=D Łódź' },
    );
    expect(JSON.parse(new URLSearchParams(req.data).get('parameters')!)).toEqual({ filter_name: 'A&B + C=D Łódź' });
  });

  it('passes a whole object argument through, nested arrays and keys included', async () => {
    const order = { order_status_id: 1, products: [{ name: 'Mug', quantity: 2, price_brutto: 9.5 }] };
    const req = await sent({ bodyEncoding: 'form-urlencoded', bodyMapping: { parameters: { __json: '$order' } } }, { order });
    expect(JSON.parse(new URLSearchParams(req.data).get('parameters')!)).toEqual(order);
  });

  it('sends {} when nothing resolves', async () => {
    const a = await sent({ bodyEncoding: 'form-urlencoded', bodyMapping: { parameters: { __json: {} } } }, {});
    expect(new URLSearchParams(a.data).get('parameters')).toBe('{}');
    mockedAxios.mockReset();
    const b = await sent({ bodyEncoding: 'form-urlencoded', bodyMapping: { parameters: { __json: '$missing' } } }, {});
    expect(new URLSearchParams(b.data).get('parameters')).toBe('{}');
  });

  it('works in a JSON body too, as a string field', async () => {
    const req = await sent({ bodyMapping: { payload: { __json: { a: '$a' } }, b: '$b' } }, { a: 1, b: 'x' });
    expect(req.data).toEqual({ payload: '{"a":1}', b: 'x' });
  });

  it('ignores a marker the caller smuggles in through an argument', async () => {
    const req = await sent({ bodyEncoding: 'form-urlencoded', bodyMapping: { data: '$data' } }, { data: { __json: { x: 1 } } });
    expect(new URLSearchParams(req.data).get('data[__json][x]')).toBe('1');
  });
});

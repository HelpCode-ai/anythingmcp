import axios from 'axios';
import * as adapter from './rozetka.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { applySchemaDefaults } from '../../common/schema-defaults.util';

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  return { __esModule: true, default: jest.fn(), AxiosError: actual.AxiosError, AxiosHeaders: actual.AxiosHeaders };
});
const mockedAxios = axios as unknown as jest.Mock;

type Tool = {
  name: string;
  enabled?: boolean;
  parameters: { required?: string[]; properties?: Record<string, unknown> };
  endpointMapping: Record<string, unknown>;
};
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: Record<string, unknown>; config: { errorWhen: unknown } };
  tools: Tool[];
};
const tool = (name: string) => {
  const found = a.tools.find((entry) => entry.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
};

/**
 * The tools that write: order status and waybill, price and stock, new
 * goods, review and comment replies, buyer messages and return requests.
 * Body fields follow Rozetka's apidoc (api_data.json): OrderUpdateStatus
 * 0.0.1, PutMassUpdateItems, CreateItem, MarketReviewReplyReply,
 * PostItemCommentsCreateComment 0.0.1, PostCreateMessage 0.0.1,
 * OrderRefundSaveTtn and OrderRefundUpdateStatus. Only the fields the caller
 * gives are sent.
 */
describe('rozetka adapter: write tools', () => {
  const BASE = 'https://api-seller.rozetka.com.ua';
  const run = (name: string, params: Record<string, unknown>) => {
    const logins = { getToken: jest.fn().mockResolvedValue({ token: 'test-token' }) } as unknown as LoginTokenService;
    return new RestEngine({} as OAuth2TokenService, logins).execute(
      {
        baseUrl: a.connector.baseUrl,
        authType: a.connector.authType,
        authConfig: a.connector.authConfig,
        errorWhen: a.connector.config.errorWhen,
      } as never,
      tool(name).endpointMapping as never,
      applySchemaDefaults(tool(name).parameters as never, params),
    );
  };
  const sent = () => mockedAxios.mock.calls.at(-1)![0] as { url: string; method: string; data: unknown; params?: unknown; headers: Record<string, string> };
  const header = (name: string) => Object.entries(sent().headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

  beforeEach(() => {
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ status: 200, data: { success: true, content: {} }, headers: {} });
  });

  it('changes the order status with the waybill and comment in a PUT body', async () => {
    await run('rozetka_update_order', { id: 101647918, status: 3, ttn: '20450012345678', seller_comment: 'Sent today' });
    expect(String(sent().method).toUpperCase()).toBe('PUT');
    expect(sent().url).toBe(`${BASE}/orders/101647918`);
    expect(header('Authorization')).toBe('Bearer test-token');
    expect(sent().data).toEqual({ status: 3, ttn: '20450012345678', seller_comment: 'Sent today' });

    await run('rozetka_update_order', { id: 101647918, status: 2 });
    expect(sent().data).toEqual({ status: 2 });
  });

  it('updates price and stock with the items array as documented', async () => {
    const items = [
      { item_rz_id: 102069758, price: 450, stock_quantity: 11 },
      { item_rz_id: 192630536, stock_quantity: 0, price_promo: -1 },
    ];
    await run('rozetka_update_goods_price_stock', { items });
    expect(String(sent().method).toUpperCase()).toBe('PUT');
    expect(sent().url).toBe(`${BASE}/items/mass-update`);
    expect(sent().data).toEqual({ items });
  });

  it('creates goods with names, category, price, stock, pictures and characteristics', async () => {
    const params = [
      { id: 111, title: 'Довжина рукава', type: 'ComboBox', value: [{ id: 2222, value: 'Короткий' }] },
      { id: 4432, title: 'Вага, кг', type: 'Decimal', value: 1.3 },
    ];
    await run('rozetka_create_goods', {
      name: 'Телефон 11',
      name_ua: 'Телефон 11',
      category_id: 80007,
      price: 999,
      stock_quantity: 10,
      pictures: [{ link: 'https://example.com/img1.png' }],
      params,
      producer: { id: 0, title: 'Example Brand' },
      article: 'SKU-11',
    });
    expect(String(sent().method).toUpperCase()).toBe('POST');
    expect(sent().url).toBe(`${BASE}/items-create/create`);
    expect(header('Content-Language')).toBe('uk');
    expect(sent().data).toEqual({
      name: 'Телефон 11',
      name_ua: 'Телефон 11',
      category_id: 80007,
      price: 999,
      stock_quantity: 10,
      pictures: [{ link: 'https://example.com/img1.png' }],
      params,
      producer: { id: 0, title: 'Example Brand' },
      article: 'SKU-11',
    });
  });

  it('replies to a shop review and to a product comment', async () => {
    await run('rozetka_reply_store_review', { market_review_id: 123, order_id: 321, comment: 'Дякуємо за відгук!' });
    expect(String(sent().method).toUpperCase()).toBe('POST');
    expect(sent().url).toBe(`${BASE}/market-review-replies/reply`);
    expect(sent().data).toEqual({ market_review_id: 123, order_id: 321, comment: 'Дякуємо за відгук!' });

    await run('rozetka_reply_goods_comment', { parent_id: 3058, item_id: 19508412, text: 'Так, є в наявності.' });
    expect(sent().url).toBe(`${BASE}/item-comments/create-comment`);
    expect(sent().data).toEqual({ parent_id: 3058, item_id: 19508412, text: 'Так, є в наявності.', is_reade: 1 });
  });

  it('sends a buyer message without e-mail unless asked', async () => {
    await run('rozetka_send_message', { chat_id: 205752, receiver_id: 10621442, body: 'Відправили сьогодні.' });
    expect(String(sent().method).toUpperCase()).toBe('POST');
    expect(sent().url).toBe(`${BASE}/messages/create`);
    expect(sent().data).toEqual({ chat_id: 205752, receiver_id: 10621442, body: 'Відправили сьогодні.', sendEmailUser: 0 });
  });

  it('saves a return waybill and, when switched on, changes a return request status', async () => {
    await run('rozetka_save_refund_ttn', { id: 'AM1234567', ttn: '20450012345678' });
    expect(String(sent().method).toUpperCase()).toBe('POST');
    expect(sent().url).toBe(`${BASE}/order-refund/save-ttn`);
    expect(header('Content-Language')).toBe('uk');
    expect(sent().data).toEqual({ id: 'AM1234567', ttn: '20450012345678' });

    expect(tool('rozetka_update_refund_status').enabled).toBe(false);
    await run('rozetka_update_refund_status', { id: 'AM1234567', status_code: 14, status_description: 'Опис' });
    expect(String(sent().method).toUpperCase()).toBe('PUT');
    expect(sent().url).toBe(`${BASE}/order-refund/update-status`);
    expect(sent().data).toEqual({ id: 'AM1234567', status_code: 14, status_description: 'Опис' });
  });

  it('reports a refused write (success:false at HTTP 200) as a failure', async () => {
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({
      status: 200,
      data: { success: false, errors: { message: 'check_correctness_of_data', code: 1005, description: 'Перевірте дані', details: [] } },
      headers: {},
    });
    await expect(run('rozetka_update_order', { id: 1, status: 3 })).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('check_correctness_of_data'),
    });
  });
});

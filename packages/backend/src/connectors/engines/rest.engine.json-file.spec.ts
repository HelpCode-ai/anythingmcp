import axios from 'axios';
import FormData from 'form-data';
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
  mockedAxios.mockResolvedValue({ data: { feedId: 'F1' }, headers: {} });
  await new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    config,
    { method: 'POST', path: '/v3/feeds', ...mapping } as any,
    params,
  );
  return mockedAxios.mock.calls[0][0];
}

/** The multipart body as text, read from the form-data stream. */
function bodyText(form: FormData): string {
  return form.getBuffer().toString('utf8');
}

beforeEach(() => mockedAxios.mockReset());

describe('RestEngine __jsonFile marker', () => {
  const feed = {
    MPItemFeedHeader: { businessUnit: 'WALMART_US', locale: 'en', version: '5.0.20260829-12_49_39-api' },
    MPItem: [{ Orderable: { sku: 'SKU-1' } }],
  };

  it('uploads the resolved object as a JSON file part with a generated multipart boundary', async () => {
    const req = await sent(
      { bodyEncoding: 'form-data', bodyMapping: { file: { __jsonFile: '$feed', __filename: 'feed.json' } } },
      { feed },
    );
    expect(req.data).toBeInstanceOf(FormData);
    expect(req.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    const text = bodyText(req.data);
    expect(text).toContain('Content-Disposition: form-data; name="file"; filename="feed.json"');
    expect(text).toContain('Content-Type: application/json');
    expect(text).toContain(JSON.stringify(feed));
    expect(text).not.toContain('__jsonFile');
  });

  it('replaces a connector-wide JSON Content-Type with the multipart one', async () => {
    mockedAxios.mockResolvedValue({ data: { feedId: 'F1' }, headers: {} });
    await new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
      { ...config, headers: { Accept: 'application/json', 'Content-Type': 'application/json' } } as any,
      { method: 'POST', path: '/v3/feeds', bodyEncoding: 'form-data', bodyMapping: { file: { __jsonFile: '$feed' } } } as any,
      { feed },
    );
    const headers = mockedAxios.mock.calls[0][0].headers;
    const contentTypes = Object.keys(headers).filter((h) => h.toLowerCase() === 'content-type');
    expect(contentTypes).toEqual(['content-type']);
    expect(headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    expect(headers.Accept).toBe('application/json');
  });

  it('resolves a template inside the marker and drops omitted arguments', async () => {
    const req = await sent(
      {
        bodyEncoding: 'form-data',
        bodyMapping: {
          file: { __jsonFile: { LagTimeHeader: { version: '1.0' }, lagTime: '$items', note: '$missing' }, __filename: 'lagtime.json' },
        },
      },
      { items: [{ sku: 'SKU-1', fulfillmentLagTime: 1 }] },
    );
    const text = bodyText(req.data);
    expect(text).toContain('filename="lagtime.json"');
    expect(text).toContain('{"LagTimeHeader":{"version":"1.0"},"lagTime":[{"sku":"SKU-1","fulfillmentLagTime":1}]}');
  });

  it('takes a string argument as JSON text already, and defaults the filename', async () => {
    const req = await sent({ bodyEncoding: 'form-data', bodyMapping: { file: { __jsonFile: '$feed' } } }, { feed: '{"a":1}' });
    const text = bodyText(req.data);
    expect(text).toContain('filename="file.json"');
    expect(text).toContain('\r\n\r\n{"a":1}\r\n');
  });

  it('sanitizes the filename', async () => {
    const req = await sent(
      { bodyEncoding: 'form-data', bodyMapping: { file: { __jsonFile: '$feed', __filename: '../x y".json' } } },
      { feed },
    );
    expect(bodyText(req.data)).toContain('filename=".._x_y_.json"');
  });

  it('leaves the part out when the argument is missing, keeping other fields', async () => {
    const req = await sent(
      { bodyEncoding: 'form-data', bodyMapping: { file: { __jsonFile: '$feed', __filename: 'feed.json' }, name: '$name' } },
      { name: 'n' },
    );
    const text = bodyText(req.data);
    expect(text).not.toContain('name="file"');
    expect(text).not.toContain('feed.json');
    expect(text).toContain('name="name"');
  });

  it('treats a caller-supplied marker as an ordinary object', async () => {
    const req = await sent(
      { bodyEncoding: 'form-data', bodyMapping: { data: '$data' } },
      { data: { __jsonFile: { a: 1 } } },
    );
    const text = bodyText(req.data);
    expect(text).not.toContain('filename=');
    expect(text).toContain('name="data[__jsonFile][a]"');
  });

  it('refuses the marker outside a multipart body', async () => {
    for (const bodyEncoding of [undefined, 'form-urlencoded']) {
      mockedAxios.mockReset();
      await expect(
        sent({ bodyEncoding, bodyMapping: { file: { __jsonFile: '$feed' } } }, { feed }),
      ).rejects.toThrow(/__jsonFile marker/);
      expect(mockedAxios).not.toHaveBeenCalled();
    }
  });
});

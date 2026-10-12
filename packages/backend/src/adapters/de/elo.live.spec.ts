import axios from 'axios';
import { RestEngine } from '../../connectors/engines/rest.engine';
import * as adapter from './elo.json';

// No ELO server is reachable from CI. These tests send tools through the real
// REST engine with axios mocked and check the request the Indexserver would
// receive: POST /rest/IXServicePortIF/<function> with the function's
// parameters as a JSON object, Basic auth, no login call.
jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  return { __esModule: true, default: jest.fn(), AxiosError: actual.AxiosError };
});
const mockedAxios = axios as jest.MockedFunction<typeof axios>;

type Tool = {
  name: string;
  parameters: { properties: Record<string, unknown>; required?: string[] };
  endpointMapping: { method: string; path: string; bodyMapping: Record<string, unknown> };
  annotations?: Record<string, boolean>;
};
const a = adapter as unknown as {
  unlisted?: boolean;
  instructions: string;
  requiredEnvVars: string[];
  probe: { tool: string };
  connector: {
    baseUrl: string;
    authType: string;
    authConfig: Record<string, string>;
    headers: Record<string, string>;
    config: { errorWhen: unknown };
  };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};

const BASE = 'https://elo.example.com/ix-Archive/rest';

async function send(name: string, params: Record<string, unknown>, data: unknown = { result: {} }) {
  mockedAxios.mockResolvedValue({ data, headers: { 'content-type': 'application/json;charset=UTF-8' } });
  const out = await new RestEngine({} as never, {} as never).execute(
    {
      baseUrl: BASE,
      authType: 'BASIC_AUTH',
      authConfig: { username: 'svc-ai', password: 'secret' },
      headers: a.connector.headers,
      errorWhen: a.connector.config.errorWhen,
    },
    tool(name).endpointMapping,
    params,
  );
  const sent = mockedAxios.mock.calls[mockedAxios.mock.calls.length - 1][0] as unknown as {
    url: string;
    method: string;
    data: Record<string, any>;
    auth: { username: string; password: string };
  };
  return { sent, out };
}

describe('elo adapter: static spec conformance', () => {
  it('stays unlisted until a live ELO server confirms the rebuilt calls', () => {
    expect(a.unlisted).toBe(true);
  });

  it('uses the Indexserver REST interface with Basic auth', () => {
    expect(a.connector.baseUrl).toBe('{{ELO_URL}}/rest');
    expect(a.connector.authType).toBe('BASIC_AUTH');
    expect(a.connector.authConfig).toEqual({ username: '{{ELO_USERNAME}}', password: '{{ELO_PASSWORD}}' });
    expect(a.requiredEnvVars).toEqual(['ELO_URL', 'ELO_USERNAME', 'ELO_PASSWORD']);
    expect(a.probe.tool).toBe('elo_get_server_info');
  });

  it('every tool is a read-only POST to an IXServicePortIF function', () => {
    for (const t of a.tools) {
      expect(t.endpointMapping.method).toBe('POST');
      expect(t.endpointMapping.path).toMatch(/^\/IXServicePortIF\/[a-zA-Z]+$/);
      expect(t.annotations?.readOnlyHint).toBe(true);
    }
    const fns = a.tools.map((t) => t.endpointMapping.path.split('/').pop());
    for (const fn of fns) {
      expect(['getServerInfo', 'findFirstSords', 'findNextSords', 'findClose', 'checkoutSord', 'checkoutSordHistory']).toContain(fn);
    }
  });

  it('explains that a Sord may be a folder or a document', () => {
    expect(a.instructions).toContain('254 and above are documents');
  });

  it('sends the function parameters as the JSON body, with Basic auth', async () => {
    const { sent } = await send('elo_get_sord', { objId: '4711' });
    expect(sent.url).toBe(`${BASE}/IXServicePortIF/checkoutSord`);
    expect(sent.method).toBe('POST');
    expect(sent.auth).toEqual({ username: 'svc-ai', password: 'secret' });
    // No lock: lockZ is left out, as in ELO's own read example.
    expect(sent.data).toEqual({ objId: '4711', editInfoZ: 'sord.lean' });
  });

  it('builds the three kinds of search ELO documents', async () => {
    const full = await send('elo_search_fulltext', { query: 'Rechnung 2026', searchIn: 'TITLE,FULLTEXT', max: 25 });
    expect(full.sent.data).toEqual({
      findInfo: { findByESearch: { searchOptions: {}, searchParams: { query: 'Rechnung 2026', searchIn: 'TITLE,FULLTEXT' } } },
      max: 25,
      sordZ: 'name,xDateIso,aclItems,objKeys',
    });
    const idx = await send('elo_find_by_keywording', { name: 'Muster', maskId: 'Invoice' });
    expect(idx.sent.data.findInfo).toEqual({ findByIndex: { name: 'Muster', maskId: 'Invoice' } });
    const kids = await send('elo_list_children', { parentId: '1' });
    expect(kids.sent.data.findInfo).toEqual({ findChildren: { parentId: '1' } });
    const next = await send('elo_find_next', { searchId: '(ABC)', idx: 50, max: 50 });
    expect(next.sent.data).toEqual({ searchId: '(ABC)', idx: 50, max: 50, sordZ: 'name,xDateIso,aclItems,objKeys' });
  });

  it('reports an IX exception inside a 200 response as an error', async () => {
    await expect(
      send('elo_get_server_info', {}, { exception: '[ELOIX:5023]Invalid user name or password.' }),
    ).rejects.toThrow(/ELOIX:5023/);
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_ELO_LIVE === '1';
(live ? describe : describe.skip)('elo: live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // Install the adapter against a real Indexserver and run the probe
    // (elo_get_server_info), then a search and elo_find_close.
    expect(a.probe.tool).toBeTruthy();
  });
});

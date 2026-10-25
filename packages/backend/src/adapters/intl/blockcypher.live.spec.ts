import * as adapter from './blockcypher.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';
import axios from 'axios';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';

/**
 * BlockCypher API v1 (www.blockcypher.com/dev/bitcoin and /dev/ethereum): https://api.blockcypher.com/v1/{coin}/{chain}/...,
 * keyless for read-only GET calls, optional token as the `token` query parameter.
 * Live part: RUN_BLOCKCYPHER_LIVE=1 npx jest src/adapters/intl/blockcypher (BLOCKCYPHER_TOKEN=... optional)
 * (reads only: chain state, one address balance, one block; mind the 100 requests per hour of the free tier).
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, unknown>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  responseMapping?: unknown;
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean; kind?: string }>;
  probe?: { tool: string; params?: Record<string, unknown> };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig?: Record<string, unknown>; headers?: Record<string, string>; config?: Record<string, unknown> };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
// Connector variables (upper case) are filled in by the connector, not by the model.
const isEnv = (p: string) => /^[A-Z][A-Z0-9_]*$/.test(p);
// Every argument a tool reads: {path} segments, "$arg" values and "${arg}" inside strings.
const used = (t: Tool) => {
  const m = t.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) out.add(p);
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      if (v.startsWith('$') && !v.includes('${')) out.add(v.slice(1));
      for (const [, p] of v.matchAll(/\$\{(\w+)\}/g)) out.add(p);
    } else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(m.queryParams ?? {});
  walk(m.bodyMapping ?? {});
  walk(m.headers ?? {});
  for (const p of [...out]) if (isEnv(p)) out.delete(p);
  return out;
};

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const mocked = jest.fn();
  return {
    __esModule: true,
    default: Object.assign(mocked, actual.default, { __actual: actual.default }),
    AxiosError: actual.AxiosError,
    AxiosHeaders: actual.AxiosHeaders,
  };
});
const mockedAxios = axios as unknown as jest.Mock;
const engine = () => new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
// Runs a tool through the real REST engine (axios mocked) and returns the request it built.
const request = async (name: string, args: Record<string, unknown>, env: Record<string, string> = {}) => {
  mockedAxios.mockReset();
  mockedAxios.mockResolvedValue({ status: 200, data: {}, headers: {} });
  const fill = (s: string) => s.replace(/\{\{(\w+)\}\}/g, (_, k) => env[k] ?? '');
  const authConfig = JSON.parse(fill(JSON.stringify(a.connector.authConfig ?? {})));
  await engine().execute(
    { baseUrl: fill(a.connector.baseUrl), authType: a.connector.authType, authConfig, headers: a.connector.headers } as never,
    JSON.parse(fill(JSON.stringify(tool(name).endpointMapping))),
    { ...env, ...args },
  );
  return mockedAxios.mock.calls[mockedAxios.mock.calls.length - 1][0] as { method: string; url: string; params?: Record<string, unknown>; data?: unknown; headers: Record<string, string> };
};
const PREFIX = 'blockcypher_';
const WRITES: string[] = [];
const transform = (name: string, body: unknown) => applyResponseTransform(body, tool(name).responseMapping as never).value;
void transform;

describe('blockcypher adapter: static spec conformance', () => {
  it('needs no credentials and sends the optional token only when it is set', () => {
    expect(a.requiredEnvVars).toEqual([]);
    expect(a.optionalEnvVars).toEqual(['BLOCKCYPHER_TOKEN']);
    expect(a.connector.authType).toBe('NONE');
    expect(a.connector.baseUrl).toBe('https://api.blockcypher.com/v1');
    expect(a.envVarMeta?.BLOCKCYPHER_TOKEN.secret).toBe(true);
    for (const t of a.tools) {
      expect(t.endpointMapping.method).toBe('GET');
      expect(t.endpointMapping.queryParams?.token).toBe('${BLOCKCYPHER_TOKEN}');
      expect(t.endpointMapping.path.startsWith('/{network}')).toBe(true);
      expect(t.parameters?.required).toContain('network');
    }
  });

  it('maps the documented chain, block, address and transaction routes', () => {
    expect(tool('blockcypher_get_chain').endpointMapping.path).toBe('/{network}');
    expect(tool('blockcypher_get_block').endpointMapping).toMatchObject({ path: '/{network}/blocks/{block}', queryParams: { txstart: '$txstart', limit: '$limit' } });
    expect(tool('blockcypher_get_address_balance').endpointMapping.path).toBe('/{network}/addrs/{address}/balance');
    expect(tool('blockcypher_get_address').endpointMapping).toMatchObject({ path: '/{network}/addrs/{address}', queryParams: { unspentOnly: '$unspent_only', before: '$before', after: '$after', limit: '$limit', includeConfidence: '$include_confidence' } });
    expect(tool('blockcypher_get_address_full').endpointMapping).toMatchObject({ path: '/{network}/addrs/{address}/full', queryParams: { before: '$before', after: '$after', limit: '$limit', txlimit: '$txlimit', confirmations: '$confirmations' } });
    expect(tool('blockcypher_get_transaction').endpointMapping).toMatchObject({ path: '/{network}/txs/{tx_hash}', queryParams: { limit: '$limit', instart: '$instart', outstart: '$outstart' } });
    expect(tool('blockcypher_get_transaction_confidence').endpointMapping.path).toBe('/{network}/txs/{tx_hash}/confidence');
    expect(tool('blockcypher_list_unconfirmed_transactions').endpointMapping).toMatchObject({ path: '/{network}/txs', queryParams: { limit: '$limit', minValue: '$min_value' } });
  });

  it('offers exactly the documented coin/chain pairs', () => {
    const net = (tool('blockcypher_get_chain').parameters?.properties as Record<string, { enum: string[] }>).network.enum;
    expect(net).toEqual(['btc/main', 'btc/test3', 'ltc/main', 'doge/main', 'dash/main', 'eth/main', 'bcy/test', 'beth/test']);
    expect(a.probe).toEqual({ tool: 'blockcypher_get_chain', params: { network: 'btc/main' } });
  });

  it('builds the request URL with coin/chain and leaves the token out when it is not set', async () => {
    const keyless = await request('blockcypher_get_address_full', { network: 'eth/main', address: '738d145faabb1e00cf5a017588a9c0f998318012', limit: 5 });
    expect(keyless.url).toBe('https://api.blockcypher.com/v1/eth/main/addrs/738d145faabb1e00cf5a017588a9c0f998318012/full');
    expect(keyless.params).toEqual({ limit: 5 });
    const withToken = await request('blockcypher_get_chain', { network: 'btc/main' }, { BLOCKCYPHER_TOKEN: 'abc' });
    expect(withToken.url).toBe('https://api.blockcypher.com/v1/btc/main');
    expect(withToken.params).toEqual({ token: 'abc' });
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
    }
  });

  it('writes are annotated and installed switched off; reads are GET or marked read-only', () => {
    const off = a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort();
    expect(off).toEqual([...WRITES].sort());
    for (const t of a.tools) {
      if (t.annotations?.readOnlyHint === false) continue;
      expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
      if (t.endpointMapping.method !== 'GET') expect(`${t.name}:${t.annotations?.readOnlyHint}`).toBe(`${t.name}:true`);
    }
    for (const n of WRITES) expect(tool(n).annotations?.readOnlyHint).toBe(false);
  });

  it('probes with a read tool and documents every tool in the instructions', () => {
    const probe = tool(a.probe!.tool);
    expect(probe.annotations?.readOnlyHint === false).toBe(false);
    for (const r of probe.parameters?.required ?? []) expect(a.probe!.params?.[r]).toBeDefined();
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/\u2014/);
  });
});

const live = process.env.RUN_BLOCKCYPHER_LIVE === '1' ? describe : describe.skip;
live('blockcypher adapter: live (read-only)', () => {
  const token = process.env.BLOCKCYPHER_TOKEN ? `?token=${process.env.BLOCKCYPHER_TOKEN}` : '';
  const get = async (path: string) => {
    const res = await fetch(`https://api.blockcypher.com/v1${path}${token}`, { headers: { Accept: 'application/json' } });
    expect(res.status).toBe(200);
    return res.json() as Promise<Record<string, unknown>>;
  };
  it('reads the chain, an address balance and a block', async () => {
    const chain = await get('/btc/main');
    expect(chain.name).toBe('BTC.main');
    expect(typeof chain.height).toBe('number');
    const bal = await get('/btc/main/addrs/1DEP8i3QJCsomS4BSMY2RpU1upv62aGvhD/balance');
    expect(typeof bal.final_balance).toBe('number');
    const block = await get('/btc/main/blocks/294322');
    expect(block.height).toBe(294322);
  }, 60_000);
});

import * as adapter from './helius.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';
import axios from 'axios';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';

/**
 * Helius (www.helius.dev/docs): Solana JSON-RPC and DAS on https://mainnet.helius-rpc.com, Enhanced Transactions on
 * /v0/..., Wallet API (beta) on https://api.helius.xyz/v1/wallet/...; the API key travels as the api-key query parameter.
 * Live part: HELIUS_API_KEY=... RUN_HELIUS_LIVE=1 npx jest src/adapters/intl/helius
 * (reads only: epoch info, the SOL balance and the signatures of a public address).
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
const PREFIX = 'helius_';
const WRITES: string[] = [];
const transform = (name: string, body: unknown) => applyResponseTransform(body, tool(name).responseMapping as never).value;
void transform;

describe('helius adapter: static spec conformance', () => {
  it('sends the API key as the api-key query parameter to Helius mainnet', () => {
    expect(a.requiredEnvVars).toEqual(['HELIUS_API_KEY']);
    expect(a.connector.baseUrl).toBe('https://mainnet.helius-rpc.com');
    expect(a.connector.authType).toBe('QUERY_AUTH');
    expect(a.connector.authConfig).toEqual({ 'api-key': '{{HELIUS_API_KEY}}' });
    expect(a.envVarMeta?.HELIUS_API_KEY.secret).toBe(true);
    expect(a.probe).toEqual({ tool: 'helius_get_epoch_info' });
  });

  it('builds JSON-RPC 2.0 bodies for the RPC and DAS tools', async () => {
    const bal = await request('helius_get_balance', { address: 'Addr1' }, { HELIUS_API_KEY: 'k' });
    expect(bal.method.toUpperCase()).toBe('POST');
    expect(bal.url).toBe('https://mainnet.helius-rpc.com/');
    expect(bal.params).toEqual({ 'api-key': 'k' });
    expect(bal.data).toEqual({ jsonrpc: '2.0', id: 'anythingmcp', method: 'getBalance', params: ['Addr1'] });
    const sigs = await request('helius_get_signatures_for_address', { address: 'Addr1', limit: 5 }, { HELIUS_API_KEY: 'k' });
    expect(sigs.data).toEqual({ jsonrpc: '2.0', id: 'anythingmcp', method: 'getSignaturesForAddress', params: ['Addr1', { limit: 5 }] });
    const assets = await request('helius_get_assets_by_owner', { owner_address: 'Owner1', show_fungible: true, show_native_balance: false }, { HELIUS_API_KEY: 'k' });
    expect(assets.data).toEqual({ jsonrpc: '2.0', id: 'anythingmcp', method: 'getAssetsByOwner', params: { ownerAddress: 'Owner1', displayOptions: { showFungible: true, showNativeBalance: false } } });
    expect(tool('helius_get_transaction').endpointMapping.bodyMapping).toEqual({ jsonrpc: '2.0', id: 'anythingmcp', method: 'getTransaction', params: ['$signature', { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1 }] });
    expect((tool('helius_get_asset').endpointMapping.bodyMapping as { params: unknown }).params).toEqual({ id: '$asset_id' });
    expect((tool('helius_get_token_accounts').endpointMapping.bodyMapping as { params: unknown }).params).toEqual({ owner: '$owner', mint: '$mint', page: '$page', limit: '$limit' });
    expect((tool('helius_get_epoch_info').endpointMapping.bodyMapping as { method: string }).method).toBe('getEpochInfo');
  });

  it('maps Enhanced Transactions and the Wallet API with their documented parameter names', async () => {
    const hist = await request('helius_get_address_transactions', { address: 'Addr1', before_signature: 'sig9', token_accounts: 'balanceChanged', limit: 10 }, { HELIUS_API_KEY: 'k' });
    expect(hist.url).toBe('https://mainnet.helius-rpc.com/v0/addresses/Addr1/transactions');
    expect(hist.params).toEqual({ 'api-key': 'k', limit: 10, 'before-signature': 'sig9', 'token-accounts': 'balanceChanged' });
    expect(tool('helius_parse_transactions').endpointMapping).toMatchObject({ method: 'POST', path: '/v0/transactions', bodyMapping: { transactions: '$signatures' } });
    const wb = await request('helius_get_wallet_balances', { address: 'W1', show_nfts: true }, { HELIUS_API_KEY: 'k' });
    expect(wb.url).toBe('https://api.helius.xyz/v1/wallet/W1/balances');
    expect(wb.params).toEqual({ 'api-key': 'k', showNfts: true });
    for (const n of ['history', 'transfers', 'identity', 'funded-by']) {
      const t = a.tools.find((x) => x.endpointMapping.path === `https://api.helius.xyz/v1/wallet/{address}/${n}`);
      expect(`${n}:${!!t}`).toBe(`${n}:true`);
    }
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

const live = process.env.RUN_HELIUS_LIVE === '1' && process.env.HELIUS_API_KEY ? describe : describe.skip;
live('helius adapter: live (read-only)', () => {
  const url = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
  const rpcCall = async (method: string, params?: unknown) => {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'spec', method, params }) });
    expect(res.status).toBe(200);
    return ((await res.json()) as { result: Record<string, unknown> }).result;
  };
  it('reads epoch info, a balance and signatures of a public address', async () => {
    const epoch = await rpcCall('getEpochInfo');
    expect(typeof epoch.absoluteSlot).toBe('number');
    const bal = await rpcCall('getBalance', ['86xCnPeV69n6t3DnyGvkKobf9FdN2H9oiVDdaMpo2MMY']);
    expect(typeof bal.value).toBe('number');
    const sigs = (await rpcCall('getSignaturesForAddress', ['86xCnPeV69n6t3DnyGvkKobf9FdN2H9oiVDdaMpo2MMY', { limit: 2 }])) as unknown as unknown[];
    expect(Array.isArray(sigs)).toBe(true);
  }, 60_000);
});

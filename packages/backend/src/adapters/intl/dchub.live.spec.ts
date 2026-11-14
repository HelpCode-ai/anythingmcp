import * as adapter from './dchub.json';
import { localMcpToolName } from '../../connectors/mcp-connector-config.util';

/**
 * The DC Hub adapter bridges DC Hub's official remote MCP server
 * (https://dchub.cloud/mcp). DC Hub's server owns the tools; the adapter's
 * `tools` array is the snapshot the catalog shows and the policy layer:
 * which tools install switched off, and which parameters are dropped.
 *
 *   1. Static, always runs. Pins what makes this connector unusual:
 *      - the API key is OPTIONAL. The server lists its tools and answers
 *        previews without a key (an empty X-API-Key header is accepted,
 *        verified live), so DCHUB_API_KEY stays in optionalEnvVars and the
 *        install stays one click;
 *      - the tools that act for the user outside AnythingMCP (an email address
 *        sent to DC Hub, subscriptions, alerts, webhooks, accepted terms,
 *        operator introductions) install switched off;
 *      - the per-call payment parameters are never offered to the model.
 *
 *   2. Live, skipped unless RUN_DCHUB_LIVE is set. Lists the server's tools
 *      without a key and checks that every tool the snapshot switches off or
 *      trims still exists under the same name, so the policy keeps applying.
 *
 *   Run live with:  RUN_DCHUB_LIVE=1 npx jest src/adapters/intl/dchub.live.spec.ts
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  omitParameters?: string[];
  parameters: { properties?: Record<string, { description?: string }>; required?: string[] };
  endpointMapping: { method: string; path: string };
  annotations?: Record<string, unknown>;
};

const a = adapter as unknown as {
  description: string;
  instructions: string;
  requiredEnvVars: string[];
  optionalEnvVars: string[];
  probe?: unknown;
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig: { headerName: string; apiKey: string };
    headers: Record<string, string>;
    config: { mcpToolPrefix: string };
  };
  tools: Tool[];
};

const SWITCHED_OFF = [
  'accept_capacity_terms',
  'bind_email',
  'claim_free_key',
  'delete_standing_intent',
  'recover_my_key',
  'register_standing_intent',
  'report_finding',
  'request_capacity_intro',
  'set_market_alert',
  'set_shortlist_alert',
  'set_site_alert',
  'subscribe_digest',
];
const PAYMENT_PARAMETERS = ['mpp_pay', 'mpp_credential'];

describe('dchub adapter: static spec conformance', () => {
  it("bridges DC Hub's official MCP server with an optional X-API-Key", () => {
    expect(a.connector.type).toBe('MCP');
    expect(a.connector.baseUrl).toBe('https://dchub.cloud/mcp');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'X-API-Key', apiKey: '{{DCHUB_API_KEY}}' });
    expect(a.connector.config).toEqual({ mcpToolPrefix: 'dchub_' });
    expect(a.requiredEnvVars).toEqual([]);
    expect(a.optionalEnvVars).toEqual(['DCHUB_API_KEY']);
    // An MCP adapter is checked by listing the server's tools.
    expect(a.probe).toBeUndefined();
  });

  it('names every tool <prefix><remote name> and calls it on /mcp', () => {
    expect(a.tools.length).toBeGreaterThan(50);
    const names = new Set<string>();
    for (const t of a.tools) {
      expect(t.name).toBe(localMcpToolName(t.endpointMapping.method, a.connector.config.mcpToolPrefix));
      expect(t.name.length).toBeLessThanOrEqual(64);
      expect(t.endpointMapping.path).toBe('/mcp');
      expect(names.has(t.name)).toBe(false);
      names.add(t.name);
    }
    expect([...names]).toEqual(
      expect.arrayContaining(['dchub_execute_plan', 'dchub_search_facilities', 'dchub_get_market_intel', 'dchub_get_grid_data']),
    );
  });

  it('describes every top-level parameter', () => {
    for (const t of a.tools) {
      for (const [p, def] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}: ${def.description ? 'ok' : 'missing'}`).toBe(`${t.name}.${p}: ok`);
      }
    }
  });

  it('installs the tools that act for the user outside AnythingMCP switched off', () => {
    const off = a.tools.filter((t) => t.enabled === false).map((t) => t.endpointMapping.method);
    expect(off.sort()).toEqual(SWITCHED_OFF);
    for (const name of SWITCHED_OFF) {
      expect(a.instructions).toContain(`dchub_${name}`);
    }
    // Every tool the server marks destructive is among them.
    const destructiveOn = a.tools.filter((t) => t.annotations?.destructiveHint === true && t.enabled !== false);
    expect(destructiveOn).toEqual([]);
  });

  it('never offers the per-call payment parameters to the model', () => {
    for (const t of a.tools) {
      for (const p of PAYMENT_PARAMETERS) {
        expect(Object.keys(t.parameters.properties ?? {})).not.toContain(p);
        expect(t.parameters.required ?? []).not.toContain(p);
      }
    }
    const trimmed = a.tools.filter((t) => t.omitParameters?.length);
    expect(trimmed.length).toBeGreaterThan(0);
    for (const t of trimmed) {
      expect(t.omitParameters!.every((p) => PAYMENT_PARAMETERS.includes(p))).toBe(true);
    }
  });

  it('keeps the key wording neutral and links the official endpoint', () => {
    const text = `${a.description}\n${a.instructions}`;
    expect(text).toContain('A few tools return previews without a DC Hub key; a key unlocks full answers.');
    expect(text).toContain('https://dchub.cloud/connect');
    expect(a.instructions).toContain('https://dchub.cloud/mcp');
    expect(a.description).toContain('Cite results with the as-of date returned by each tool.');
    // Our own wording names no plan: plan names change. (The tool descriptions
    // are DC Hub's own, copied from its server.)
    expect(text).not.toMatch(/\bPro\b|paid plan|plan key/i);
  });

  it('uses no em or en dashes', () => {
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });
});

const live = process.env.RUN_DCHUB_LIVE ? describe : describe.skip;

live('dchub adapter: live tools/list without a key', () => {
  jest.setTimeout(60_000);

  async function rpc(body: unknown, session?: string) {
    const res = await fetch(a.connector.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'X-API-Key': '',
        ...(session ? { 'Mcp-Session-Id': session } : {}),
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    const data = text.startsWith('{') ? text : text.split('\n').find((l) => l.startsWith('data: '))?.slice(6);
    return { res, json: data ? JSON.parse(data) : undefined };
  }

  it('lists every tool the snapshot switches off or trims', async () => {
    const init = await rpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'anythingmcp-spec', version: '1' } },
    });
    expect(init.res.status).toBe(200);
    const session = init.res.headers.get('mcp-session-id') ?? undefined;
    await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, session);
    const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, session);
    const remote = new Set<string>((list.json?.result?.tools ?? []).map((t: { name: string }) => t.name));
    expect(remote.size).toBeGreaterThan(50);
    const policy = a.tools.filter((t) => t.enabled === false || t.omitParameters?.length).map((t) => t.endpointMapping.method);
    expect(policy.filter((name) => !remote.has(name))).toEqual([]);
  });
});

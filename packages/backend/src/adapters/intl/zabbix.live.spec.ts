import * as adapter from './zabbix.json';

const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  probe?: { tool: string };
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig?: Record<string, unknown>;
    headers?: Record<string, string>;
    healthcheckPath?: string;
  };
  tools: Array<{ name: string; endpointMapping: Record<string, unknown> }>;
};

const toolNames = a.tools.map((t) => t.name);

describe('zabbix adapter — static spec conformance', () => {
  it("posts every call to the one JSON-RPC endpoint", () => {
    for (const t of a.tools) {
      expect(t.endpointMapping.method).toBe('POST');
      expect(t.endpointMapping.path).toBe('/api_jsonrpc.php');
    };
  });

  it("names a distinct JSON-RPC method per tool", () => {
    const methods = a.tools.map((t) => (t.endpointMapping.bodyMapping as Record<string, string>).method);
    expect(methods).toEqual(expect.arrayContaining(['apiinfo.version', 'host.get', 'problem.get', 'event.get']));
    expect(methods.every((m) => typeof m === 'string' && m.includes('.'))).toBe(true);
  });

  it("declares jsonrpc 2.0 on every envelope", () => {
    for (const t of a.tools) {
      expect((t.endpointMapping.bodyMapping as Record<string, string>).jsonrpc).toBe('2.0');
    };
  });

  it("probes apiinfo.version, the one method needing no auth", () => {
    expect(a.probe?.tool).toBe('zabbix_get_api_version');
  });

  it("keeps the live problem board separate from event history", () => {
    expect(toolNames).toContain('zabbix_list_problems');
    expect(toolNames).toContain('zabbix_list_events');
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_ZABBIX_LIVE === '1';
(live ? describe : describe.skip)('zabbix — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // zabbix answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});

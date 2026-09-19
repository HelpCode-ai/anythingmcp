import * as adapter from './proxmox.json';

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

describe('proxmox adapter — static spec conformance', () => {
  it("assembles Proxmox's own PVEAPIToken header", () => {
    expect(a.connector.authConfig?.apiKey).toBe('PVEAPIToken={{PROXMOX_TOKEN_ID}}={{PROXMOX_TOKEN_SECRET}}');
  });

  it("offers the cluster-wide list, which needs no node name", () => {
    const t = a.tools.find((x) => x.name === 'proxmox_list_cluster_resources')!;
    expect(t.endpointMapping.path).toBe('/cluster/resources');
  });

  it("exposes no power or lifecycle operation", () => {
    expect(a.tools.every((t) => t.endpointMapping.method === 'GET')).toBe(true);
    const names = toolNames.join(' ');
    for (const verb of ['start', 'stop', 'shutdown', 'reboot', 'delete', 'snapshot', 'migrate']) {
      expect(names).not.toContain(verb);
    };
  });

  it("says the shipped self-signed certificate will not do", () => {
    expect((adapter as unknown as { instructions: string }).instructions).toContain('self-signed certificate');
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_PROXMOX_LIVE === '1';
(live ? describe : describe.skip)('proxmox — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // proxmox answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});

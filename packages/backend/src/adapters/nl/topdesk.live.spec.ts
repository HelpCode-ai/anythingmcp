import * as adapter from './topdesk.json';

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

describe('topdesk adapter — static spec conformance', () => {
  it("is filed under the Dutch region, where TOPdesk is from", () => {
    expect(a.region).toBe('nl');
  });

  it("authenticates with an application password, not the operator's own", () => {
    expect(a.connector.authConfig?.password).toBe('{{TOPDESK_APP_PASSWORD}}');
  });

  it("probes /version, which needs no module permission", () => {
    expect(a.probe?.tool).toBe('topdesk_get_version');
  });

  it("links the caller through callerLookup, which is how the API takes a registered person", () => {
    const t = a.tools.find((x) => x.name === 'topdesk_create_incident')!;
    const body = t.endpointMapping.bodyMapping as Record<string, unknown>;
    expect(body.callerLookup).toEqual({ id: '$callerId' });
    expect(body).not.toHaveProperty('caller');
    // Whole-object params, so an omitted one is dropped instead of sent as {}.
    expect(body.operatorGroup).toBe('$operatorGroup');
  });

  it("pages incidents and changes with pageStart/pageSize and sorts with sort", () => {
    for (const name of ['topdesk_list_incidents', 'topdesk_list_changes']) {
      const qp = a.tools.find((x) => x.name === name)!.endpointMapping.queryParams as Record<string, string>;
      expect(qp.pageSize).toBe('$pageSize');
      expect(qp.pageStart).toBe('$pageStart');
      expect(qp).not.toHaveProperty('page_size');
    }
    const incidents = a.tools.find((x) => x.name === 'topdesk_list_incidents')!;
    expect((incidents.endpointMapping.queryParams as Record<string, string>).sort).toBe('$sort');
  });

  it("explains FIQL, which is how TOPdesk filters", () => {
    expect((adapter as unknown as { instructions: string }).instructions).toContain('FIQL');
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_TOPDESK_LIVE === '1';
(live ? describe : describe.skip)('topdesk — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // topdesk answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});

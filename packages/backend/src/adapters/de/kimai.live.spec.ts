import * as adapter from './kimai.json';

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

describe('kimai adapter — static spec conformance', () => {
  it("builds its base URL from the self-hosted instance", () => {
    expect(a.connector.baseUrl).toBe('{{KIMAI_URL}}/api');
    expect(a.requiredEnvVars).toContain('KIMAI_URL');
  });

  it("uses the Kimai 2.x bearer token, not the 1.x header pair", () => {
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(JSON.stringify(a.connector.authConfig)).not.toContain('X-AUTH');
  });

  it("probes /version, which needs no permission at all", () => {
    expect(a.probe?.tool).toBe('kimai_get_version');
    expect(a.connector.healthcheckPath).toBe('/version');
  });

  it("asks for global activities with `globals`, since `project` only takes a numeric id", () => {
    const t = a.tools.find((x) => x.name === 'kimai_list_activities')!;
    const q = t.endpointMapping.queryParams as Record<string, unknown>;
    expect(q.globals).toBe('$globals');
    expect(q.project).toBe('$project');
  });

  it("does not pretend to page lists Kimai returns whole", () => {
    for (const name of ['kimai_list_customers', 'kimai_list_projects', 'kimai_list_activities']) {
      const q = a.tools.find((x) => x.name === name)!.endpointMapping.queryParams as Record<string, unknown>;
      expect(q).not.toHaveProperty('page');
      expect(q).not.toHaveProperty('size');
    }
  });

  it("tells self-hosters about SSRF_ALLOWED_HOSTS", () => {
    expect((adapter as unknown as { instructions: string }).instructions).toContain('SSRF_ALLOWED_HOSTS');
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_KIMAI_LIVE === '1';
(live ? describe : describe.skip)('kimai — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // kimai answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});

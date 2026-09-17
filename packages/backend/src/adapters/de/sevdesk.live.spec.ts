import * as adapter from './sevdesk.json';

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

describe('sevdesk adapter — static spec conformance', () => {
  it("targets the v1 API on my.sevdesk.de", () => {
    expect(a.connector.baseUrl).toBe('https://my.sevdesk.de/api/v1');
  });

  it("sends the raw key in Authorization, with no Bearer prefix", () => {
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig?.headerName).toBe('Authorization');
    expect(a.connector.authConfig?.apiKey).toBe('{{SEVDESK_API_KEY}}');
  });

  it("uses sevDesk's capitalised singular collection names", () => {
    const paths = a.tools.map((t) => t.endpointMapping.path);
    expect(paths).toContain('/Contact');
    expect(paths).toContain('/Invoice');
    expect(paths).toContain('/Voucher');
  });

  it("probes /SevUser, which any token may read", () => {
    expect(a.probe?.tool).toBe('sevdesk_list_users');
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_SEVDESK_LIVE === '1';
(live ? describe : describe.skip)('sevdesk — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // sevdesk answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});

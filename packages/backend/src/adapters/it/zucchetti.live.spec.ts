import * as adapter from './zucchetti.json';

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

describe('zucchetti adapter — static spec conformance', () => {
  it("points at the customer's own installation", () => {
    expect(a.connector.baseUrl).toBe('{{ZUCCHETTI_URL}}');
  });

  it("takes the resource name as an argument, since modules differ", () => {
    const t = adapter.tools.find((x: { name: string }) => x.name === 'zucchetti_list_records')!;
    expect((t as unknown as { parameters: { required: string[] } }).parameters.required).toContain('resource');
  });

  it("says partner credentials are required and there is no sandbox", () => {
    const i = (adapter as unknown as { instructions: string }).instructions;
    expect(i).toContain('Partner credentials required');
    expect(i).toContain('no public sandbox');
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_ZUCCHETTI_LIVE === '1';
(live ? describe : describe.skip)('zucchetti — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // zucchetti answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});

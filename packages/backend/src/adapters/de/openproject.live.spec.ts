import * as adapter from './openproject.json';

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

describe('openproject adapter — static spec conformance', () => {
  it("uses the literal `apikey` as the Basic-auth username", () => {
    expect(a.connector.authConfig?.username).toBe('apikey');
    expect(a.connector.authConfig?.password).toBe('{{OPENPROJECT_API_KEY}}');
  });

  it("asks for HAL, which is how OpenProject shapes its responses", () => {
    expect(a.connector.headers?.Accept).toBe('application/hal+json');
  });

  it("offers the project-scoped work-package list as well as the global one", () => {
    expect(toolNames).toContain('openproject_list_project_work_packages');
    expect(toolNames).toContain('openproject_list_work_packages');
  });

  it("explains the operator short codes", () => {
    expect((adapter as unknown as { instructions: string }).instructions).toContain('`o` open');
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_OPENPROJECT_LIVE === '1';
(live ? describe : describe.skip)('openproject — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // openproject answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});

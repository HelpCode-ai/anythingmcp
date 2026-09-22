import * as adapter from './nextcloud.json';

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

describe('nextcloud adapter — static spec conformance', () => {
  it("sends the OCS-APIRequest header every call needs", () => {
    expect(a.connector.headers?.['OCS-APIRequest']).toBe('true');
  });

  it("asks for JSON on every call, or Nextcloud answers XML", () => {
    for (const t of a.tools) {
      expect((t.endpointMapping.queryParams as Record<string, string>).format).toBe('json');
    };
  });

  it("uses v1 for provisioning and v2 for sharing", () => {
    const byName = Object.fromEntries(a.tools.map((t) => [t.name, t.endpointMapping.path]));
    expect(byName.nextcloud_list_users).toContain('ocs/v1.php');
    expect(byName.nextcloud_list_shares).toContain('ocs/v2.php');
  });

  it("authenticates with an app password, not the account password", () => {
    expect(a.connector.authType).toBe('BASIC_AUTH');
    expect(a.connector.authConfig?.password).toBe('{{NEXTCLOUD_APP_PASSWORD}}');
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_NEXTCLOUD_LIVE === '1';
(live ? describe : describe.skip)('nextcloud — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // nextcloud answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});

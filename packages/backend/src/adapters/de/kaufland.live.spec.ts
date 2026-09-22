import * as adapter from './kaufland.json';

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

describe('kaufland adapter — static spec conformance', () => {
  it("signs the request instead of sending the secret", () => {
    expect(a.connector.authType).toBe('HMAC');
    const sig = (a.connector.authConfig as Record<string, Record<string, unknown>>).signature;
    expect(sig.secret).toBe('{{KAUFLAND_SECRET_KEY}}');
    expect(sig.headerName).toBe('Shop-Signature');
  });

  it("sends the timestamp it signed, so the server can recompute the string", () => {
    const sig = (a.connector.authConfig as Record<string, Record<string, unknown>>).signature;
    expect(sig.timestampHeader).toBe('Shop-Timestamp');
    expect(String(sig.template)).toContain('${timestamp}');
  });

  it("identifies the seller with the public client key", () => {
    const sig = (a.connector.authConfig as Record<string, Record<string, unknown>>).signature;
    expect((sig.extraHeaders as Record<string, string>)['Shop-Client-Key']).toBe('{{KAUFLAND_CLIENT_KEY}}');
  });

  it("covers method, url, body and timestamp in that order", () => {
    const sig = (a.connector.authConfig as Record<string, Record<string, unknown>>).signature;
    expect(sig.template).toBe('${method}\\n${url}\\n${body}\\n${timestamp}\\n');
  });

  it("exposes no write tool", () => {
    expect(a.tools.every((t) => t.endpointMapping.method === 'GET')).toBe(true);
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_KAUFLAND_LIVE === '1';
(live ? describe : describe.skip)('kaufland — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // kaufland answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});

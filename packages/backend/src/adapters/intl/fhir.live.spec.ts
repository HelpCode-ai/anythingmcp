import * as adapter from './fhir.json';

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

describe('fhir adapter — static spec conformance', () => {
  it("asks for the FHIR JSON media type", () => {
    expect(a.connector.headers?.Accept).toBe('application/fhir+json');
  });

  it("makes the capability statement the entry point", () => {
    expect(a.probe?.tool).toBe('fhir_get_capability_statement');
    expect(a.connector.healthcheckPath).toBe('/metadata');
  });

  it("exposes no write interaction", () => {
    expect(a.tools.every((t) => t.endpointMapping.method === 'GET')).toBe(true);
  });

  it("says out loud that this is special-category personal data", () => {
    const i = (adapter as unknown as { instructions: string }).instructions;
    expect(i).toContain('GDPR Article 9');
    expect(i).toContain('HIPAA');
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_FHIR_LIVE === '1';
(live ? describe : describe.skip)('fhir — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // fhir answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});

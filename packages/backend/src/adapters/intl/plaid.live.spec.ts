import * as adapter from './plaid.json';
import { describeAdapterEnvVars } from '../env-var-meta';

const a = adapter as unknown as {
  instructions: string;
  envVarMeta: Record<string, { help?: string; secret?: boolean }>;
  connector: { baseUrl: string; authType: string };
  tools: Array<{ endpointMapping: { bodyMapping?: Record<string, unknown> } }>;
};
describe('plaid adapter — static spec conformance', () => {
  it('sandbox.plaid.com base URL (safe default)', () =>
    expect(a.connector.baseUrl).toBe('https://sandbox.plaid.com'));
  it('every tool injects client_id + secret into the body', () => {
    for (const t of a.tools) {
      const body = t.endpointMapping.bodyMapping ?? {};
      expect(body.client_id).toBe('$PLAID_CLIENT_ID');
      expect(body.secret).toBe('$PLAID_SECRET');
    }
  });
  it('names only the environments Plaid still runs: Sandbox and Production', () => {
    // Plaid shut the Development environment down; its host no longer answers.
    expect(a.instructions).toContain('https://sandbox.plaid.com');
    expect(a.instructions).toContain('https://production.plaid.com');
    expect(a.instructions).toMatch(/Development environment no longer exists/);
    expect(a.instructions).not.toMatch(/`development`|real banks, 100 free items/);
    // Limited Production and the Trial plan both run on the Production host.
    expect(a.instructions).toMatch(/Limited Production\*\*, which also runs on production\.plaid\.com/);
    expect(a.instructions).toMatch(/Trial plan/);
    expect(a.instructions).toContain('https://dashboard.plaid.com/developers/keys');
  });
  it('explains in the secret help which secret goes with which host', () => {
    const help = a.envVarMeta.PLAID_SECRET.help ?? '';
    expect(help).toMatch(/Sandbox secret.*sandbox\.plaid\.com/);
    expect(help).toMatch(/Production secret.*https:\/\/production\.plaid\.com/);
    const described = describeAdapterEnvVars(a as never);
    expect(described.find((d) => d.name === 'PLAID_SECRET')!.secret).toBe(true);
  });
});

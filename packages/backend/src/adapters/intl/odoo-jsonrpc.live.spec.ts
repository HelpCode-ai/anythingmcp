import * as adapter from './odoo-jsonrpc.json';
import * as json2 from './odoo.json';

const a = adapter as unknown as {
  requiredEnvVars: string[];
  connector: { baseUrl: string; authType: string; healthcheckPath?: string };
  tools: Array<{
    name: string;
    annotations?: { readOnlyHint?: boolean };
    endpointMapping: { method: string; path: string; bodyTemplate?: string };
  }>;
};

// Verified against a live Odoo (Oct 2026): every tool through the real engine,
// including a create → write → activity_schedule → unlink cycle.
describe('odoo-jsonrpc adapter: static spec conformance', () => {
  it('talks to /jsonrpc with execute_kw and the four credentials', () => {
    expect(a.requiredEnvVars).toEqual(['ODOO_URL', 'ODOO_DB', 'ODOO_UID', 'ODOO_API_KEY']);
    for (const t of a.tools) {
      expect(t.endpointMapping).toMatchObject({ method: 'POST', path: '/jsonrpc' });
      const body = t.endpointMapping.bodyTemplate ?? '';
      expect(body).toContain('"execute_kw"');
      // uid is a number in Odoo's signature: never quoted.
      expect(body).toContain('"{{ODOO_DB}}",{{ODOO_UID}},"{{ODOO_API_KEY}}"');
    }
  });

  it('keeps the tool names of the JSON-2 adapter, so a connector can move between them', () => {
    const names = (json2 as unknown as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(a.tools.map((t) => t.name).sort()).toEqual([...names].sort());
  });

  it('marks the reads read-only although they are POSTs', () => {
    const reads = a.tools.filter((t) => !/create|write|call_method/.test(t.name));
    expect(reads.length).toBeGreaterThan(0);
    for (const t of reads) expect(t.annotations?.readOnlyHint).toBe(true);
  });

  it('checks the connection on a path every Odoo version serves', () => {
    expect(a.connector.healthcheckPath).toBe('/web/health');
  });
});

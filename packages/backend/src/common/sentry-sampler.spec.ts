import { sampleRateFor } from './sentry-sampler';

const rates = { base: 0.05, mcp: 0.01 };

describe('sampleRateFor', () => {
  it('samples MCP calls at the MCP rate', () => {
    expect(
      sampleRateFor(
        { name: 'POST', attributes: { 'http.method': 'POST', 'http.target': '/mcp/abc123?x=1' } },
        rates,
      ),
    ).toBe(0.01);
    expect(
      sampleRateFor(
        { name: 'POST', normalizedRequest: { method: 'POST', url: 'https://cloud.example.com/mcp/abc' } },
        rates,
      ),
    ).toBe(0.01);
    expect(sampleRateFor({ name: 'POST /mcp/abc' }, rates)).toBe(0.01);
  });

  it('samples other requests at the base rate', () => {
    expect(
      sampleRateFor(
        { name: 'GET', attributes: { 'http.request.method': 'GET', 'url.path': '/api/connectors' } },
        rates,
      ),
    ).toBe(0.05);
    // Not the MCP route, only a lookalike prefix.
    expect(
      sampleRateFor({ name: 'GET', attributes: { 'http.method': 'GET', 'http.target': '/mcpx' } }, rates),
    ).toBe(0.05);
  });

  it('never samples health probes', () => {
    expect(
      sampleRateFor({ name: 'GET', attributes: { 'http.method': 'GET', 'http.target': '/health' } }, rates),
    ).toBe(0);
  });

  it('never samples root spans that are not requests', () => {
    expect(sampleRateFor({ name: 'prisma:client:operation' }, rates)).toBe(0);
    expect(sampleRateFor({ name: 'pg-pool.connect', attributes: { 'db.system': 'postgresql' } }, rates)).toBe(0);
    expect(sampleRateFor({ name: 'SELECT "public"."kg_edges"."id" FROM "public"."kg_edges"' }, rates)).toBe(0);
  });
});

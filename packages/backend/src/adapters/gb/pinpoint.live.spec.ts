import * as adapter from './pinpoint.json';

type Tool = {
  name: string;
  parameters: { properties?: Record<string, unknown>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, string> };
};
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; headers: Record<string, string> };
  tools: Tool[];
};
const reads = a.tools.filter((t) => t.endpointMapping.method === 'GET');

describe('pinpoint adapter - static spec conformance', () => {
  it('per-company host https://<subdomain>.pinpointhq.com/api/v1', () => {
    expect(a.connector.baseUrl).toBe('https://{{PINPOINT_SUBDOMAIN}}.pinpointhq.com/api/v1');
  });

  it('API key in the X-API-KEY header', () => {
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'X-API-KEY', apiKey: '{{PINPOINT_API_KEY}}' });
  });

  it('speaks JSON:API', () => {
    expect(a.connector.headers.Accept).toBe('application/vnd.api+json');
  });

  it('list tools page with page[number] / page[size] and ask for the total', () => {
    for (const t of reads.filter((x) => x.name.startsWith('pinpoint_list_'))) {
      expect(t.endpointMapping.queryParams).toMatchObject({
        'page[number]': '$page',
        'page[size]': '$page_size',
        'stats[total]': 'count',
      });
    }
  });
});

// Keyless: Pinpoint routes before it authenticates, so a known resource answers
// 401 without a key and an unknown one 404. Uses Pinpoint's own careers tenant.
const live = process.env.RUN_PINPOINT_LIVE === '1' ? describe : describe.skip;
live('pinpoint adapter - live (no credentials)', () => {
  const base = a.connector.baseUrl.replace('{{PINPOINT_SUBDOMAIN}}', 'workwithus');

  it('an unknown resource is 404, so 401 below proves the path exists', async () => {
    expect((await fetch(`${base}/no_such_resource`)).status).toBe(404);
  });

  it.each(reads.map((t) => [t.name, t.endpointMapping.path.replace('{id}', '1')]))(
    '%s path %s exists (401 without a key)',
    async (_name, path) => {
      const res = await fetch(`${base}${path}`, { headers: { Accept: 'application/vnd.api+json' } });
      expect(res.status).toBe(401);
    },
  );
});

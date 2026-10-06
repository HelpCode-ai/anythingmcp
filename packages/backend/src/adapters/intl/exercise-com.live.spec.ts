import * as adapter from './exercise-com.json';

type Tool = {
  name: string;
  parameters: { properties?: Record<string, unknown>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, string> };
};
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: Record<string, unknown> };
  tools: Tool[];
};
const tool = (name: string) => a.tools.find((t) => t.name === name)!;

describe('exercise-com adapter - static spec conformance', () => {
  it('tenant host is a variable; tools carry the /api/v4 prefix', () => {
    expect(a.connector.baseUrl).toBe('https://{{EXERCISE_HOST}}');
    for (const t of a.tools) expect(t.endpointMapping.path).toMatch(/^\/api\/v4\//);
  });

  it('sends the API key and the bearer access token together (v4 security: api_key + bearer)', () => {
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig.headerName).toBe('API-TOKEN');
    expect(a.connector.authConfig.apiKey).toBe('{{EXERCISE_API_KEY}}');
    expect(a.connector.authConfig.extraHeaders).toEqual({ Authorization: 'Bearer {{EXERCISE_ACCESS_TOKEN}}' });
  });

  it('Ransack filters travel as a raw q[...] query fragment', () => {
    expect(tool('exercise_com_list_visits').endpointMapping.queryParams!.__rawquery).toBe('$filter');
  });

  it('appointments require a filter (unfiltered history times out upstream)', () => {
    expect(tool('exercise_com_list_appointments').parameters.required).toEqual(['filter']);
  });

  it('calendar needs a Unix-time window', () => {
    expect(tool('exercise_com_get_calendar').parameters.required).toEqual(['start', 'end']);
  });
});

// Keyless: the vendor's public demo tenant answers 401 JSON for every v4 route
// without credentials. RUN_EXERCISE_COM_LIVE=1.
const live = process.env.RUN_EXERCISE_COM_LIVE === '1' ? describe : describe.skip;
live('exercise-com adapter - live (no credentials)', () => {
  const base = a.connector.baseUrl.replace('{{EXERCISE_HOST}}', 'train.demoexercise.com');
  it.each(a.tools.filter((t) => t.endpointMapping.method === 'GET').map((t) => [t.name, t.endpointMapping.path.replace('{id}', '1')]))(
    '%s %s answers 401 without credentials',
    async (_name, path) => {
      const res = await fetch(`${base}${path}`, { headers: { Accept: 'application/json' } });
      expect(res.status).toBe(401);
    },
  );
});

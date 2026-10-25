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

  it('maps the added documented v4 reads', () => {
    expect(tool('exercise_com_get_assessment').endpointMapping).toEqual({ method: 'GET', path: '/api/v4/assessments/{id}' });
    expect(tool('exercise_com_list_appointment_packages').endpointMapping).toEqual({ method: 'GET', path: '/api/v4/fbm/appointments/{id}/packages' });
    expect(tool('exercise_com_list_group_calendars').endpointMapping).toEqual({ method: 'GET', path: '/api/v4/groups/calendars', queryParams: { per: '$per', page: '$page' } });
    expect(tool('exercise_com_list_purchased_items').endpointMapping).toEqual({ method: 'GET', path: '/api/v4/carts/purchased_items', queryParams: { user_id: '$user_id' } });
    expect(tool('exercise_com_list_user_workout_exercises').endpointMapping).toEqual({
      method: 'GET',
      path: '/api/v4/users/{id}/workout_exercises',
      queryParams: { exercise_id: '$exercise_id', with_date: '$with_date', 'q[s]': '$sort', pluck_columns: '$pluck_columns', per: '$per', page: '$page' },
    });
    expect(tool('exercise_com_list_visits').endpointMapping.queryParams).toMatchObject({ for_user: '$for_user', with_ids: '$with_ids' });
    expect(tool('exercise_com_list_scheduled_appointment_members').endpointMapping.queryParams).toMatchObject({ for_user: '$for_user' });
  });

  it('every declared parameter reaches the request, path parameters are required, every tool is in the instructions', () => {
    const ins = (adapter as unknown as { instructions: string }).instructions;
    for (const t of a.tools) {
      const used = new Set(Object.values(t.endpointMapping.queryParams ?? {}).map((v) => v.replace(/^\$/, '')));
      for (const [, p] of t.endpointMapping.path.matchAll(/\{(\w+)\}/g)) {
        used.add(p);
        expect(`${t.name}:${p}:${(t.parameters.required ?? []).includes(p)}`).toBe(`${t.name}:${p}:true`);
      }
      const walk = (v: unknown): void => {
        if (typeof v === 'string' && v.startsWith('$')) used.add(v.slice(1));
        else if (v && typeof v === 'object') Object.values(v).forEach(walk);
      };
      walk((t.endpointMapping as { bodyMapping?: unknown }).bodyMapping);
      for (const p of Object.keys(t.parameters.properties ?? {})) expect(`${t.name}:${p}:${used.has(p)}`).toBe(`${t.name}:${p}:true`);
      expect(`${t.name}:${ins.includes(t.name)}`).toBe(`${t.name}:true`);
    }
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

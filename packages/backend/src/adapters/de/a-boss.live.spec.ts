import * as adapter from './a-boss.json';
import { serializeRepeatedParams } from '../../connectors/engines/rest.engine';

type Tool = {
  name: string;
  parameters: { properties: Record<string, unknown>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, string> };
};
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
  probe: { tool: string };
  tools: Tool[];
};
const tool = (name: string) => a.tools.find((t) => t.name === name)!;
const MODULES = ['events', 'deals', 'projects', 'locations', 'travels', 'contacts', 'invoices', 'contracts', 'advancings'];

describe('a-boss adapter: static spec conformance', () => {
  it('agency-api.a-boss.net with a Bearer API key', () => {
    expect(a.connector.baseUrl).toBe('https://agency-api.a-boss.net');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig.token).toBe('{{ABOSS_API_KEY}}');
  });

  it('a list and a get tool for every v1 module, all GET (the API is read-only)', () => {
    for (const m of MODULES) {
      const singular = m.replace(/s$/, '');
      expect(tool(`a_boss_list_${m}`).endpointMapping).toMatchObject({ method: 'GET', path: `/v1/${m}` });
      expect(tool(`a_boss_get_${singular}`).endpointMapping).toMatchObject({ method: 'GET', path: `/v1/${m}/{id}` });
    }
    expect(a.tools.every((t) => t.endpointMapping.method === 'GET')).toBe(true);
  });

  it('date ranges use the deepObject form start[gte] / start[lte]', () => {
    expect(tool('a_boss_list_events').endpointMapping.queryParams).toMatchObject({
      'start[gte]': '$start_from',
      'start[lte]': '$start_to',
      'updated_at[gte]': '$updated_at_from',
      'status[]': '$status',
      'project_id[]': '$project_ids',
    });
  });

  it('array filters go out as repeated id[] keys', () => {
    expect(serializeRepeatedParams({ 'id[]': [1, 2] })).toBe('id%5B%5D=1&id%5B%5D=2');
  });

  it('probe lists one event (the events scope is always on the key)', () => {
    expect(a.probe.tool).toBe('a_boss_list_events');
  });
});

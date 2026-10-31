import * as adapter from './phantombuster.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';

/**
 * PhantomBuster API v2 (hub.phantombuster.com/reference, OpenAPI at
 * github.com/phantombuster/public-gists/blob/master/swagger-api-v2.json):
 * base https://api.phantombuster.com/api/v2, API key in the X-Phantombuster-Key
 * header (the server names that header when the key is missing), ids as query
 * parameters on GET and in the JSON body on POST, dates in Unix milliseconds.
 * Live part (reads only: org, resources, agents, the last output and runs of the first agent, lists):
 *   PHANTOMBUSTER_API_KEY=... RUN_PHANTOMBUSTER_LIVE=1 npx jest src/adapters/intl/phantombuster
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { enum?: unknown[] }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  responseMapping?: unknown;
};
const a = adapter as unknown as {
  slug: string;
  requiredEnvVars: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean; kind?: string }>;
  probe: { tool: string };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig?: Record<string, unknown>; healthcheckPath?: string };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
// Every argument a tool reads: {path} segments, "$arg" values and "${arg}" inside strings.
const used = (t: Tool) => {
  const m = t.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) out.add(p);
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      if (v.startsWith('$') && !v.includes('${')) out.add(v.slice(1));
      for (const [, p] of v.matchAll(/\$\{(\w+)\}/g)) out.add(p);
    } else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(m.queryParams ?? {});
  walk(m.bodyMapping ?? {});
  walk(m.headers ?? {});
  return out;
};
const PREFIX = 'phantombuster_';
const WRITES = [
  'launch_agent',
  'launch_agent_soon',
  'abort_agent',
  'save_agent',
  'save_lead_list',
  'save_lead',
  'delete_leads',
  'delete_lead_list',
  'delete_agent',
  'unschedule_all_agents',
].map((n) => PREFIX + n);
const OFF = ['delete_leads', 'delete_lead_list', 'delete_agent', 'unschedule_all_agents'].map((n) => PREFIX + n);

describe('phantombuster adapter: static spec conformance', () => {
  it('sends the API key in the X-Phantombuster-Key header to the v2 base URL', () => {
    expect(a.requiredEnvVars).toEqual(['PHANTOMBUSTER_API_KEY']);
    expect(a.connector.baseUrl).toBe('https://api.phantombuster.com/api/v2');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'X-Phantombuster-Key', apiKey: '{{PHANTOMBUSTER_API_KEY}}' });
    expect(a.envVarMeta?.PHANTOMBUSTER_API_KEY.secret).toBe(true);
    expect(a.connector.healthcheckPath).toBe('/orgs/fetch');
    for (const t of a.tools) expect(t.endpointMapping.path).toMatch(/^\/(agents|containers|orgs|scripts|org-storage)\//);
  });

  it('maps the agent endpoints: ids in the query on GET, in the body on POST', () => {
    expect(tool('phantombuster_list_agents').endpointMapping).toEqual({
      method: 'GET',
      path: '/agents/fetch-all',
      queryParams: { agentIds: '$agent_ids', inputTypes: '$input_types', outputTypes: '$output_types', withArgument: '$with_argument' },
    });
    expect(tool('phantombuster_get_agent').endpointMapping).toEqual({ method: 'GET', path: '/agents/fetch', queryParams: { id: '$agent_id', withManifest: '$with_manifest' } });
    expect(tool('phantombuster_get_agent_output').endpointMapping).toEqual({
      method: 'GET',
      path: '/agents/fetch-output',
      queryParams: { id: '$agent_id', fromOutputPos: '$from_output_pos', prevContainerId: '$prev_container_id' },
    });
    expect(tool('phantombuster_launch_agent').endpointMapping).toEqual({
      method: 'POST',
      path: '/agents/launch',
      bodyMapping: { id: '$agent_id', argument: '$argument', bonusArgument: '$bonus_argument', saveArgument: '$save_argument', maxInstanceCount: '$max_instance_count' },
    });
    expect(tool('phantombuster_launch_agent_soon').endpointMapping.bodyMapping).toEqual({ id: '$agent_id', minutes: '$minutes', argument: '$argument' });
    expect(tool('phantombuster_abort_agent').endpointMapping).toEqual({ method: 'POST', path: '/agents/stop', bodyMapping: { id: '$agent_id', softAbort: '$soft_abort', switchToManualLaunch: '$switch_to_manual_launch' } });
    expect(tool('phantombuster_save_agent').endpointMapping).toMatchObject({ method: 'POST', path: '/agents/save', bodyMapping: { id: '$agent_id', script: '$script_id', launchType: '$launch_type', repeatedLaunchPreset: '$repeated_launch_preset' } });
    expect(tool('phantombuster_save_agent').parameters?.properties?.launch_type.enum).toEqual(['manually', 'repeatedly', 'once', 'after agent']);
    expect(tool('phantombuster_delete_agent').endpointMapping).toEqual({ method: 'POST', path: '/agents/delete', bodyMapping: { id: '$agent_id' } });
  });

  it('maps the container, org and script endpoints', () => {
    expect(tool('phantombuster_list_containers').endpointMapping).toEqual({
      method: 'GET',
      path: '/containers/fetch-all',
      queryParams: { agentId: '$agent_id', limit: '$limit', mode: '$mode', beforeEndedAt: '$before_ended_at' },
    });
    expect(tool('phantombuster_get_container').endpointMapping).toMatchObject({ path: '/containers/fetch', queryParams: { id: '$container_id', withOutput: '$with_output', withResultObject: '$with_result_object' } });
    expect(tool('phantombuster_get_container_output').endpointMapping).toEqual({ method: 'GET', path: '/containers/fetch-output', queryParams: { id: '$container_id', mode: '$mode' } });
    expect(tool('phantombuster_get_container_result').endpointMapping).toEqual({ method: 'GET', path: '/containers/fetch-result-object', queryParams: { id: '$container_id' } });
    expect(tool('phantombuster_get_org').endpointMapping).toEqual({ method: 'GET', path: '/orgs/fetch' });
    expect(tool('phantombuster_get_org_resources').endpointMapping).toEqual({ method: 'GET', path: '/orgs/fetch-resources' });
    expect(tool('phantombuster_list_running_containers').endpointMapping.path).toBe('/orgs/fetch-running-containers');
    expect(tool('phantombuster_export_agent_usage').endpointMapping).toEqual({ method: 'GET', path: '/orgs/export-agent-usage', queryParams: { days: '$days' } });
    expect(tool('phantombuster_export_container_usage').endpointMapping.queryParams).toEqual({ days: '$days', agentId: '$agent_id' });
    expect(tool('phantombuster_get_script').endpointMapping.queryParams).toEqual({ id: '$script_id', branch: '$branch', environment: '$environment' });
    expect(tool('phantombuster_list_scripts').endpointMapping.queryParams).toEqual({ org: '$org', scriptIds: '$script_ids', exclude: '$exclude' });
  });

  it('maps the org storage (leads and lists) endpoints', () => {
    expect(tool('phantombuster_list_lead_lists').endpointMapping).toEqual({ method: 'GET', path: '/org-storage/lists/fetch-all' });
    expect(tool('phantombuster_get_lead_list').endpointMapping).toEqual({ method: 'GET', path: '/org-storage/lists/fetch', queryParams: { id: '$list_id' } });
    expect(tool('phantombuster_list_leads_in_list').endpointMapping).toEqual({
      method: 'POST',
      path: '/org-storage/leads/by-list/{list_id}',
      bodyMapping: {
        paginationOptions: { paginationSize: '$page_size', paginationOffset: '$offset', paginationOrder: '$order', includeTotalCount: '$include_total_count' },
        withCompanies: '$with_companies',
      },
    });
    expect(tool('phantombuster_save_lead_list').endpointMapping.bodyMapping).toEqual({ id: '$list_id', name: '$name', filter: '$filter', description: '$description', tags: '$tags' });
    expect(tool('phantombuster_save_lead').endpointMapping).toMatchObject({ path: '/org-storage/leads/save', bodyMapping: { linkedinProfileUrl: '$linkedin_profile_url', linkedinJobTitle: '$job_title' } });
    expect(tool('phantombuster_delete_leads').endpointMapping).toEqual({ method: 'POST', path: '/org-storage/leads/delete-many', bodyMapping: { ids: '$lead_ids' } });
    expect(tool('phantombuster_delete_lead_list').endpointMapping).toEqual({ method: 'POST', path: '/org-storage/lists/delete', bodyMapping: { id: '$list_id' } });
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
    }
  });

  it('reads are GET or marked read-only; writes are POST, deletes are destructive and switched off', () => {
    for (const t of a.tools) {
      if (WRITES.includes(t.name)) {
        expect(`${t.name}:${t.endpointMapping.method}`).toBe(`${t.name}:POST`);
        expect(t.annotations?.readOnlyHint).toBeUndefined();
      } else {
        expect(`${t.name}:${t.endpointMapping.method === 'GET' || t.annotations?.readOnlyHint === true}`).toBe(`${t.name}:true`);
      }
      expect(`${t.name}:${t.enabled === false}`).toBe(`${t.name}:${OFF.includes(t.name)}`);
    }
    for (const n of [...OFF, 'phantombuster_abort_agent', 'phantombuster_save_agent']) expect(tool(n).annotations?.destructiveHint).toBe(true);
  });

  it('removes manifests, proxy credentials and identity tokens from the answers', () => {
    const agents = applyResponseTransform([{ id: '1', name: 'A', manifest: { big: true } }] as never, tool('phantombuster_list_agents').responseMapping as never).value;
    expect(agents).toEqual([{ id: '1', name: 'A' }]);
    const agent = applyResponseTransform({ id: '1', proxyUsername: 'u', proxyPassword: 'p', s3Folder: 's' } as never, tool('phantombuster_get_agent').responseMapping as never).value;
    expect(agent).toEqual({ id: '1', s3Folder: 's' });
    const org = applyResponseTransform({ id: 'o', s3Folder: 'f', timezone: 'Europe/Paris', identityTokens: ['secret'], vatId: 'x' } as never, tool('phantombuster_get_org').responseMapping as never).value;
    expect(org).toEqual({ id: 'o', s3Folder: 'f', timezone: 'Europe/Paris' });
  });

  it('probes with a read tool and documents every tool in the instructions', () => {
    expect(a.probe.tool).toBe('phantombuster_get_org');
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_PHANTOMBUSTER_LIVE === '1' && process.env.PHANTOMBUSTER_API_KEY ? describe : describe.skip;
live('phantombuster adapter: live (read-only)', () => {
  const get = async (path: string) => {
    const res = await fetch(`${a.connector.baseUrl}${path}`, { headers: { 'X-Phantombuster-Key': String(process.env.PHANTOMBUSTER_API_KEY), Accept: 'application/json' } });
    expect(`${path}:${res.status}`).toBe(`${path}:200`);
    return (await res.json()) as unknown;
  };
  it('reads the org, its resources, the agents, the last output and runs of an agent, and the lead lists', async () => {
    expect(await get('/orgs/fetch')).toHaveProperty('id');
    expect(await get('/orgs/fetch-resources')).toBeDefined();
    const agents = (await get('/agents/fetch-all')) as Array<{ id: string }>;
    expect(Array.isArray(agents)).toBe(true);
    if (agents.length > 0) {
      expect(await get(`/agents/fetch?id=${agents[0].id}`)).toHaveProperty('id', agents[0].id);
      expect(await get(`/agents/fetch-output?id=${agents[0].id}`)).toHaveProperty('status');
      expect(await get(`/containers/fetch-all?agentId=${agents[0].id}&limit=5`)).toHaveProperty('containers');
    }
    expect(await get('/org-storage/lists/fetch-all')).toBeDefined();
  }, 60_000);
});

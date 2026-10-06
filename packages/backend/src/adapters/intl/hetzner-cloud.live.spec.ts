import * as adapter from './hetzner-cloud.json';
type Tool = {
  name: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, unknown>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    queryParams?: Record<string, unknown>;
    bodyMapping?: unknown;
    bodyTemplate?: string;
    headers?: Record<string, string>;
  };
  annotations?: Record<string, boolean>;
};
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: Record<string, unknown>; headers?: Record<string, string> };
  probe: { tool: string; params?: Record<string, unknown> };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const refs = (v: unknown, out: Set<string>) => {
  if (typeof v === 'string') {
    if (/^\$\w+$/.test(v)) out.add(v.slice(1));
    for (const [, p] of v.matchAll(/\$\{(\w+)\}/g)) out.add(p);
  } else if (v && typeof v === 'object') for (const x of Object.values(v)) refs(x, out);
};

describe('hetzner-cloud adapter: static spec conformance', () => {
  it('uses API v1 with a bearer project token', () => {
    expect(a.connector.baseUrl).toBe('https://api.hetzner.cloud/v1');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig.token).toBe('{{HETZNER_CLOUD_API_TOKEN}}');
  });

  it('power tools are destructive, disabled by default, and the only writes', () => {
    const writes = a.tools.filter((t) => t.endpointMapping.method !== 'GET');
    expect(writes.map((t) => t.name).sort()).toEqual([
      'hetzner_cloud_power_off_server',
      'hetzner_cloud_power_on_server',
      'hetzner_cloud_reboot_server',
      'hetzner_cloud_reset_server',
      'hetzner_cloud_shutdown_server',
    ]);
    for (const t of writes) {
      expect(t.enabled).toBe(false);
      expect(t.annotations?.destructiveHint).toBe(true);
      expect(t.endpointMapping.path).toMatch(/^\/servers\/\{id\}\/actions\/(poweron|poweroff|shutdown|reboot|reset)$/);
    }
  });

  it('has no delete tool and nothing that creates or rebuilds', () => {
    for (const t of a.tools) {
      expect(t.endpointMapping.method).not.toBe('DELETE');
      expect(t.name).not.toMatch(/delete|create|rebuild/);
    }
  });

  it('metrics tools pass the documented type, start, end and step', () => {
    expect(tool('hetzner_cloud_get_server_metrics').endpointMapping.queryParams).toEqual({ type: '$type', start: '$start', end: '$end', step: '$step' });
  });

  (a.probe ? it : it.skip)('probe is a read-only tool whose required parameters are given', () => {
    const p = tool(a.probe.tool);
    expect(p.endpointMapping.method === 'GET' || p.annotations?.readOnlyHint === true).toBe(true);
    for (const r of p.parameters?.required ?? []) expect(a.probe.params?.[r]).toBeDefined();
  });

  it('every declared parameter reaches the request', () => {
    for (const t of a.tools) {
      const m = t.endpointMapping;
      const used = new Set<string>();
      for (const [, p] of m.path.matchAll(/\{(\w+)\}/g)) used.add(p);
      refs(m.queryParams, used);
      refs(m.bodyMapping, used);
      refs(m.headers, used);
      if (m.bodyTemplate) refs(m.bodyTemplate, used);
      for (const p of Object.keys(t.parameters?.properties ?? {})) expect(`${t.name}:${p}:${used.has(p)}`).toBe(`${t.name}:${p}:true`);
    }
  });

  it('tool names carry the adapter prefix and are unique', () => {
    const names = a.tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n.startsWith('hetzner_cloud_')).toBe(true);
  });
});

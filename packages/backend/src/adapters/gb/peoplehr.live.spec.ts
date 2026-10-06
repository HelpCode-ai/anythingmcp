import * as adapter from './peoplehr.json';

type Tool = {
  name: string;
  parameters: { properties?: Record<string, unknown>; required?: string[] };
  endpointMapping: { method: string; path: string; bodyMapping: Record<string, string> };
  annotations?: { readOnlyHint?: boolean };
};
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; headers: Record<string, string> };
  probe: { tool: string };
  tools: Tool[];
};
const isRead = (t: Tool) => /^Get/i.test(t.endpointMapping.bodyMapping.Action);

// PeopleHR has no keyless endpoint, so this spec is static only.
describe('peoplehr adapter - static spec conformance', () => {
  it('api.peoplehr.net, key in the body rather than a header', () => {
    expect(a.connector.baseUrl).toBe('https://api.peoplehr.net');
    expect(a.connector.authType).toBe('NONE');
  });

  it('sends an explicit User-Agent (the CDN blocks some default agents)', () => {
    expect(a.connector.headers['User-Agent']).toMatch(/AnythingMCP/);
  });

  it('every tool is a POST carrying APIKey and an Action', () => {
    for (const t of a.tools) {
      expect(t.endpointMapping.method).toBe('POST');
      expect(t.endpointMapping.bodyMapping.APIKey).toBe('{{PEOPLEHR_API_KEY}}');
      expect(t.endpointMapping.bodyMapping.Action).toMatch(/^[A-Za-z]+$/);
    }
  });

  it('read actions are marked read-only, writes are not', () => {
    for (const t of a.tools) {
      if (isRead(t)) expect(t.annotations?.readOnlyHint).toBe(true);
      else expect(t.annotations?.readOnlyHint).toBeUndefined();
    }
  });

  it('every declared parameter reaches the body', () => {
    for (const t of a.tools) {
      const sent = Object.values(t.endpointMapping.bodyMapping);
      for (const name of Object.keys(t.parameters.properties ?? {})) {
        expect(sent).toContain(`$${name}`);
      }
    }
  });

  it('the probe is a read tool without required parameters', () => {
    const probe = a.tools.find((t) => t.name === a.probe.tool)!;
    expect(isRead(probe)).toBe(true);
    expect(probe.parameters.required ?? []).toHaveLength(0);
  });
});

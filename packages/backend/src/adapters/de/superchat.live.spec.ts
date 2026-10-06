import * as adapter from './superchat.json';

type Tool = {
  name: string;
  enabled?: boolean;
  annotations?: Record<string, boolean>;
  parameters: { properties: Record<string, { default?: unknown }>; required?: string[] };
  endpointMapping: { method: string; path: string; bodyTemplate?: string };
};
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
  probe: { tool: string };
  tools: Tool[];
};
const tool = (name: string) => a.tools.find((t) => t.name === name)!;
const SENDERS = ['superchat_send_message', 'superchat_send_template', 'superchat_send_email'];

describe('superchat adapter: static spec conformance', () => {
  it('api.superchat.com/v1.0 with the X-API-KEY header', () => {
    expect(a.connector.baseUrl).toBe('https://api.superchat.com/v1.0');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'X-API-KEY', apiKey: '{{SUPERCHAT_API_KEY}}' });
  });

  it('send tools are destructive and install switched off', () => {
    for (const name of SENDERS) {
      const t = tool(name);
      expect(t.endpointMapping).toMatchObject({ method: 'POST', path: '/messages' });
      expect(t.annotations?.destructiveHint).toBe(true);
      expect(t.enabled).toBe(false);
    }
  });

  it('send bodies follow PASendMessageDTO: to[], from{channel_id,name}, typed content', () => {
    for (const name of SENDERS) {
      const body = tool(name).endpointMapping.bodyTemplate!;
      const rendered = JSON.parse(body.replace(/"\$\{\w+\}"/g, '"x"').replace(/\$\{\w+\}/g, 'null'));
      expect(rendered.to).toEqual([{ identifier: 'x' }]);
      expect(rendered.from).toEqual({ channel_id: 'x', name: null });
      expect(typeof rendered.content.type).toBe('string');
    }
  });

  it('template variables and e-mail attachments default to an empty list, never null', () => {
    expect(tool('superchat_send_template').parameters.properties.variables.default).toEqual([]);
    expect(tool('superchat_send_email').parameters.properties.attachments.default).toEqual([]);
  });

  it('contact search is a read-only POST with one exact-match expression', () => {
    const t = tool('superchat_search_contacts');
    expect(t.annotations?.readOnlyHint).toBe(true);
    expect(JSON.parse(t.endpointMapping.bodyTemplate!.replace(/\$\{\w+\}/g, 'x'))).toEqual({
      query: { value: [{ field: 'x', operator: '=', value: 'x' }] },
    });
  });

  it('probe is /me', () => expect(tool(a.probe.tool).endpointMapping.path).toBe('/me'));
});

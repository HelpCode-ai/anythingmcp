import * as adapter from './gorgias.json';
const a = adapter as unknown as { connector: { baseUrl: string; authType: string } };
describe('gorgias adapter — static spec conformance', () => {
  it('per-subdomain baseUrl with placeholder', () =>
    expect(a.connector.baseUrl).toBe('https://{{GORGIAS_SUBDOMAIN}}.gorgias.com/api'));
  it('Basic auth (email + API key)', () =>
    expect(a.connector.authType).toBe('BASIC_AUTH'));
});

describe('gorgias adapter: messages and macros', () => {
  const tools = (adapter as unknown as {
    tools: Array<{ name: string; enabled?: boolean; endpointMapping: { method: string; path: string; queryParams?: Record<string, string> } }>;
  }).tools;
  const t = (name: string) => {
    const found = tools.find((x) => x.name === name);
    if (!found) throw new Error(`missing tool ${name}`);
    return found;
  };

  it('maps the documented message and macro endpoints', () => {
    const expected: Array<[string, string, string]> = [
      ['gorgias_list_all_messages', 'GET', '/messages'],
      ['gorgias_find_macros', 'GET', '/macros'],
      ['gorgias_read_macro', 'GET', '/macros/{macro_id}'],
      ['gorgias_add_macro', 'POST', '/macros'],
      ['gorgias_edit_macro', 'PUT', '/macros/{macro_id}'],
      ['gorgias_remove_macro', 'DELETE', '/macros/{macro_id}'],
    ];
    for (const [name, method, path] of expected) expect(t(name).endpointMapping).toMatchObject({ method, path });
    expect(t('gorgias_list_all_messages').endpointMapping.queryParams).toMatchObject({ ticket_id: '$ticket_id', cursor: '$cursor' });
  });

  it('installs the macro delete switched off', () => {
    expect(t('gorgias_remove_macro').enabled).toBe(false);
    expect(t('gorgias_add_macro').enabled).toBeUndefined();
  });

  it('prefixes every tool and names each one in the instructions', () => {
    const instructions = (adapter as unknown as { instructions: string }).instructions;
    for (const tool of tools) {
      expect(tool.name.startsWith('gorgias_')).toBe(true);
    }
    for (const name of ['gorgias_list_all_messages', 'gorgias_find_macros', 'gorgias_read_macro', 'gorgias_add_macro', 'gorgias_edit_macro', 'gorgias_remove_macro']) {
      expect(instructions).toContain(name);
    }
  });
});

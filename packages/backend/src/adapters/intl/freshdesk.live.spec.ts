import * as adapter from './freshdesk.json';
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: Record<string,string> };
};
describe('freshdesk adapter — static spec conformance', () => {
  it('domain-templated base URL', () => {
    expect(a.connector.baseUrl).toBe('https://{{FRESHDESK_DOMAIN}}.freshdesk.com/api/v2');
  });
  it('BASIC_AUTH with key as username and X as password', () => {
    expect(a.connector.authType).toBe('BASIC_AUTH');
    expect(a.connector.authConfig.username).toBe('{{FRESHDESK_API_KEY}}');
    expect(a.connector.authConfig.password).toBe('X');
  });
});

describe('freshdesk_search_tickets query', () => {
  it('asks for the double quotes Freshdesk requires', () => {
    const tool = (adapter as unknown as {
      tools: { name: string; description: string; parameters: { properties: { query: { description: string } } } }[];
    }).tools.find((t) => t.name === 'freshdesk_search_tickets')!;
    expect(tool.parameters.properties.query.description).toContain('double quotes');
    expect(tool.description).not.toContain("'status:2");
  });
});

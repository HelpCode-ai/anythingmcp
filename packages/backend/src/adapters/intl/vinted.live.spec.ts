import * as adapter from './vinted.json';

const a = adapter as unknown as {
  slug: string;
  category: string;
  connector: { baseUrl: string; authType: string };
  tools: Array<{ name: string }>;
};

describe('vinted adapter — static spec conformance', () => {
  it('has the expected slug + non-empty tool set', () => {
    expect(a.slug).toBe('vinted');
    expect(a.connector.baseUrl).toMatch(/^https:\/\//);
    expect(a.tools.length).toBeGreaterThan(0);
  });

  it('all tools have a name starting with the adapter slug prefix', () => {
    const prefix = a.slug.replace(/-/g, '_');
    a.tools.forEach((t) => expect(t.name.startsWith(prefix + '_')).toBe(true));
  });
});

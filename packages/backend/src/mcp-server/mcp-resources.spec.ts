import {
  RESOURCE_PLACEHOLDER_TEXT,
  callerConnectorIds,
  connectorInstructionsUri,
  planServerResources,
  serverInstructionsUri,
  staticResourceText,
} from './mcp-resources';

describe('callerConnectorIds', () => {
  const tools = [
    { id: 't-crm-1', connectorId: 'c-crm' },
    { id: 't-crm-2', connectorId: 'c-crm' },
    { id: 't-fibu', connectorId: 'c-fibu' },
  ];

  it('keeps only connectors owning at least one role-allowed tool', () => {
    expect(callerConnectorIds(tools, ['t-crm-2'], ['c-crm', 'c-fibu'])).toEqual(['c-crm']);
  });

  it('a role allowing nothing yields no connector', () => {
    expect(callerConnectorIds(tools, [], ['c-crm', 'c-fibu'])).toEqual([]);
  });

  it('an allowed id outside the server tools adds nothing', () => {
    expect(callerConnectorIds(tools, ['t-elsewhere'], ['c-crm'])).toEqual([]);
  });

  it('an unrestricted caller keeps every assigned connector', () => {
    expect(callerConnectorIds(tools, null, ['c-crm', 'c-fibu', 'c-empty'])).toEqual([
      'c-crm',
      'c-fibu',
      'c-empty',
    ]);
  });
});

describe('staticResourceText', () => {
  it('serves an explicit string text or content', () => {
    expect(staticResourceText({ text: 'hello' })).toBe('hello');
    expect(staticResourceText({ content: 'body' })).toBe('body');
    expect(staticResourceText({ text: '' })).toBe('');
  });

  it('never serializes a data object, even next to other fields', () => {
    expect(staticResourceText({ data: { apiKey: 'sk_live_123' } })).toBeNull();
    expect(staticResourceText({ text: { apiKey: 'sk_live_123' } })).toBeNull();
    expect(staticResourceText({ content: ['a'] })).toBeNull();
  });

  it('never treats a URL as content', () => {
    expect(staticResourceText({ url: 'https://example.com/secret.json' })).toBeNull();
    expect(staticResourceText({ type: 'http', method: 'GET', path: '/x' })).toBeNull();
  });

  it('rejects non-object configs', () => {
    expect(staticResourceText(null)).toBeNull();
    expect(staticResourceText('text')).toBeNull();
    expect(staticResourceText(['text'])).toBeNull();
  });
});

describe('planServerResources', () => {
  const row = (connectorId: string, uri: string, fetchConfig: unknown, extra = {}) => ({
    connectorId,
    uri,
    name: uri,
    description: null,
    mimeType: 'text/markdown',
    fetchConfig,
    ...extra,
  });

  const base = {
    serverId: 'srv-1',
    serverName: 'Sales',
    instructions: 'Server guidance\n\n## CRM\nUse the CRM.',
    connectors: [{ id: 'c-crm', name: 'CRM', instructions: 'Use the CRM.' }],
    resources: [],
  };

  it('publishes the composed instructions and one resource per connector', () => {
    const plan = planServerResources(base);
    expect(plan.resources.map((r) => r.uri)).toEqual([
      'anythingmcp://server/srv-1/instructions',
      'anythingmcp://server/srv-1/connector/c-crm/instructions',
    ]);
    expect(plan.resources[0].text).toBe(base.instructions);
    expect(plan.resources[1]).toMatchObject({ text: 'Use the CRM.', connectorId: 'c-crm' });
  });

  it('builds URIs that survive the SDK lookup unchanged', () => {
    for (const uri of [
      serverInstructionsUri('cmabc123'),
      connectorInstructionsUri('cmabc123', 'cmdef456'),
    ]) {
      expect(new URL(uri).toString()).toBe(uri);
    }
  });

  it('publishes nothing for empty instructions', () => {
    const plan = planServerResources({
      ...base,
      instructions: undefined,
      connectors: [{ id: 'c-crm', name: 'CRM', instructions: '' }],
    });
    expect(plan.resources).toEqual([]);
  });

  it('serves a stored data object as the placeholder, never the object', () => {
    const plan = planServerResources({
      ...base,
      resources: [row('c-crm', 'crm://config', { data: { password: 'hunter2' } })],
    });
    const r = plan.resources.find((x) => x.uri === 'crm://config')!;
    expect(r.text).toBe(RESOURCE_PLACEHOLDER_TEXT);
    expect(r.mimeType).toBe('text/plain');
    expect(JSON.stringify(plan)).not.toContain('hunter2');
  });

  it('serves a remote-URL config as the placeholder', () => {
    const plan = planServerResources({
      ...base,
      resources: [row('c-crm', 'crm://remote', { url: 'https://internal.example/secret' })],
    });
    const r = plan.resources.find((x) => x.uri === 'crm://remote')!;
    expect(r.text).toBe(RESOURCE_PLACEHOLDER_TEXT);
    expect(JSON.stringify(plan)).not.toContain('internal.example');
  });

  it('serves explicit stored text with its mime type', () => {
    const plan = planServerResources({
      ...base,
      resources: [row('c-crm', 'crm://schema', { text: '# Schema' })],
    });
    expect(plan.resources.find((x) => x.uri === 'crm://schema')).toMatchObject({
      text: '# Schema',
      mimeType: 'text/markdown',
      connectorId: 'c-crm',
    });
  });

  it('falls back to text/plain for an odd stored mime type', () => {
    const plan = planServerResources({
      ...base,
      resources: [row('c-crm', 'crm://x', { text: 'x' }, { mimeType: 'text/html; <script>' })],
    });
    expect(plan.resources.find((x) => x.uri === 'crm://x')!.mimeType).toBe('text/plain');
  });

  it('withholds every claimant of a duplicate URI', () => {
    const plan = planServerResources({
      ...base,
      connectors: [
        { id: 'c-crm', name: 'CRM', instructions: 'a' },
        { id: 'c-fibu', name: 'Fibu', instructions: 'b' },
      ],
      resources: [
        row('c-crm', 'shared://doc', { text: 'from crm' }),
        row('c-fibu', 'shared://doc', { text: 'from fibu' }),
        row('c-fibu', 'fibu://only', { text: 'kept' }),
      ],
    });
    expect(plan.ambiguous).toEqual(['shared://doc']);
    expect(plan.resources.map((r) => r.uri)).not.toContain('shared://doc');
    expect(plan.resources.map((r) => r.uri)).toContain('fibu://only');
    expect(JSON.stringify(plan.resources)).not.toMatch(/from (crm|fibu)/);
  });

  it('detects duplicates after URI normalization', () => {
    const plan = planServerResources({
      ...base,
      resources: [
        row('c-crm', 'CRM://schema', { text: 'a' }),
        row('c-fibu', 'crm://schema', { text: 'b' }),
      ],
    });
    expect(plan.ambiguous).toEqual(['crm://schema']);
    expect(plan.resources.map((r) => r.uri)).not.toContain('crm://schema');
  });

  it('rejects stored rows that use the reserved scheme or are not URIs', () => {
    const plan = planServerResources({
      ...base,
      resources: [
        row('c-crm', 'anythingmcp://server/srv-1/instructions', { text: 'spoof' }),
        row('c-crm', 'AnythingMCP://server/srv-1/knowledge-graph', { text: 'spoof' }),
        row('c-crm', 'not a uri', { text: 'x' }),
      ],
    });
    expect(plan.rejected).toHaveLength(3);
    // The genuine server instructions are untouched by the spoof attempt.
    const own = plan.resources.find((r) => r.uri === serverInstructionsUri('srv-1'))!;
    expect(own.text).toBe(base.instructions);
    expect(JSON.stringify(plan.resources)).not.toContain('spoof');
  });
});

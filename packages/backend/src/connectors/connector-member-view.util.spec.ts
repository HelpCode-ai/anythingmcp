import {
  MEMBER_CONNECTOR_FIELDS,
  MEMBER_TOOL_FIELDS,
  seesMemberView,
  toMemberConnector,
  toMemberTool,
} from './connector-member-view.util';

describe('connector member view', () => {
  const tool = {
    id: 't1',
    connectorId: 'c1',
    name: 'ledger_list',
    description: 'Lists ledger entries',
    isEnabled: true,
    parameters: { type: 'object', properties: { period: { type: 'string' } } },
    endpointMapping: { method: 'QUERY', path: 'SELECT * FROM ledger_entries' },
    responseMapping: null,
    annotations: null,
    outputSchema: null,
    createdAt: new Date(0),
  };
  const connector = {
    id: 'c1',
    userId: 'owner',
    organizationId: 'org',
    name: 'Ledger',
    type: 'DATABASE',
    baseUrl: 'postgresql://report_user@db.example.invalid:5432/ledger',
    authType: 'BASIC_AUTH',
    isActive: true,
    credentialScope: 'SHARED',
    envVars: { REGION: 'eu' },
    maskedEnvVars: [],
    headers: null,
    maskedHeaders: [],
    config: { readOnly: true },
    instructions: 'Internal',
    specUrl: null,
    icon: 'postgresql',
    setupStatus: 'ready',
    missingVariables: [],
    authStatus: null,
    authStatusCode: null,
    authStatusMessage: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    tools: [tool],
  };

  it('keeps the allowlisted fields and nothing else', () => {
    expect(toMemberConnector(connector)).toEqual({
      id: 'c1',
      name: 'Ledger',
      type: 'DATABASE',
      icon: 'postgresql',
      isActive: true,
      credentialScope: 'SHARED',
      setupStatus: 'ready',
      authStatus: null,
      authStatusCode: null,
      memberView: true,
      tools: [{ id: 't1', name: 'ledger_list', description: 'Lists ledger entries', isEnabled: true }],
    });
    expect(toMemberTool(tool)).toEqual({ id: 't1', name: 'ledger_list', description: 'Lists ledger entries', isEnabled: true });
  });

  it('a field added to the model later does not appear by itself', () => {
    const later = { ...connector, internalHost: '10.0.0.5', tools: [{ ...tool, rawQuery: 'SELECT 1' }] };
    const view = toMemberConnector(later);
    expect(Object.keys(view).sort()).toEqual([...MEMBER_CONNECTOR_FIELDS, 'memberView', 'tools'].sort());
    expect(Object.keys(view.tools[0]).sort()).toEqual([...MEMBER_TOOL_FIELDS].sort());
    expect(JSON.stringify(view)).not.toContain('10.0.0.5');
    expect(JSON.stringify(view)).not.toContain('SELECT');
  });

  it('does not invent fields the source lacks, and always answers with a tool list', () => {
    expect(toMemberConnector({ id: 'c2', name: 'Bare' })).toEqual({ id: 'c2', name: 'Bare', memberView: true, tools: [] });
    expect(toMemberConnector({ id: 'c3', tools: 'not a list' }).tools).toEqual([]);
  });

  it('a caller cannot switch the marker off through the source object', () => {
    expect(toMemberConnector({ id: 'c4', memberView: false, tools: [] }).memberView).toBe(true);
  });

  it('only a restricted member who does not own the connector gets the reduced view', () => {
    const owned = { userId: 'me' };
    const others = { userId: 'someone-else' };
    expect(seesMemberView({ restricted: false }, others)).toBe(false);
    expect(seesMemberView({ restricted: true, userId: 'me', allowedToolIds: ['t1'], ownerAccess: true }, owned)).toBe(false);
    expect(seesMemberView({ restricted: true, userId: 'me', allowedToolIds: ['t1'], ownerAccess: true }, others)).toBe(true);
    // No tool whitelist: every connector is visible, another member's still reduced.
    expect(seesMemberView({ restricted: true, userId: 'me', allowedToolIds: null, ownerAccess: true }, others)).toBe(true);
  });

  it('a restricted VIEWER gets the reduced view even of a connector they own', () => {
    const owned = { userId: 'me' };
    expect(seesMemberView({ restricted: true, userId: 'me', allowedToolIds: ['t1'], ownerAccess: false }, owned)).toBe(true);
    expect(seesMemberView({ restricted: true, userId: 'me', allowedToolIds: null, ownerAccess: false }, owned)).toBe(true);
  });
});

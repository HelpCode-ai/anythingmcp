import {
  CALLER_CONTEXT_PREFIX,
  CALLER_CONTEXT_VARIABLES,
  buildCallerContextVars,
  findUnknownCallerContextVars,
  usesCallerContext,
} from './caller-context.util';
import {
  interpolateConnectorConfig,
  interpolateDeep,
  interpolateString,
} from './env-interpolation.util';

const opts = { reservedPrefix: CALLER_CONTEXT_PREFIX };

const context = {
  userId: 'usr_1',
  userEmail: 'dominik@example.com',
  organizationId: 'org_1',
  mcpServerId: 'srv_1',
  mcpServerName: 'Prod',
  authMethod: 'jwt',
  apiKeyName: undefined,
};

describe('buildCallerContextVars', () => {
  it('exposes the caller identity', () => {
    const vars = buildCallerContextVars(context);
    expect(vars['amcp.user_email']).toBe('dominik@example.com');
    expect(vars['amcp.user_id']).toBe('usr_1');
    expect(vars['amcp.org_id']).toBe('org_1');
    expect(vars['amcp.server_id']).toBe('srv_1');
    expect(vars['amcp.auth_method']).toBe('jwt');
  });

  it('defines every documented variable even with no context at all', () => {
    // Instance-wide static credentials and anonymous mode carry no identity;
    // the variables must still resolve so no placeholder reaches the target.
    const vars = buildCallerContextVars(undefined);
    for (const key of Object.keys(CALLER_CONTEXT_VARIABLES)) {
      expect(vars[key]).toBe('');
    }
  });

  it('resolves a missing single field to an empty string', () => {
    expect(buildCallerContextVars(context)['amcp.api_key_name']).toBe('');
  });
});

describe('interpolation of reserved variables', () => {
  it('substitutes the caller e-mail into a header value', () => {
    expect(
      interpolateString(
        'user={{amcp.user_email}}',
        buildCallerContextVars(context),
        opts,
      ),
    ).toBe('user=dominik@example.com');
  });

  it('tolerates surrounding whitespace in the placeholder', () => {
    expect(
      interpolateString('{{ amcp.user_id }}', buildCallerContextVars(context), opts),
    ).toBe('usr_1');
  });

  it('resolves an unavailable value to empty rather than leaking the placeholder', () => {
    expect(
      interpolateString('u={{amcp.user_email}}', buildCallerContextVars(undefined), opts),
    ).toBe('u=');
  });

  it('blanks an unknown reserved variable instead of sending braces downstream', () => {
    expect(
      interpolateString('x={{amcp.typo}}', buildCallerContextVars(context), opts),
    ).toBe('x=');
  });

  it('still leaves a non-reserved unknown variable untouched', () => {
    expect(interpolateString('{{NOT_SET}}', {}, opts)).toBe('{{NOT_SET}}');
  });

  it('substitutes inside nested structures', () => {
    expect(
      interpolateDeep(
        { audit: { by: '{{amcp.user_email}}' }, tags: ['{{amcp.org_id}}'] },
        buildCallerContextVars(context),
        opts,
      ),
    ).toEqual({ audit: { by: 'dominik@example.com' }, tags: ['org_1'] });
  });

  it('cannot be shadowed by a workspace env var', () => {
    // Reserved values are merged last precisely so a connector variable (which
    // a workspace admin controls) cannot spoof the caller identity.
    const vars = {
      'amcp.user_email': 'attacker@evil.test',
      ...buildCallerContextVars(context),
    };
    expect(interpolateString('{{amcp.user_email}}', vars, opts)).toBe(
      'dominik@example.com',
    );
  });

  it('reaches headers, query params, body and path via the connector config', () => {
    const result = interpolateConnectorConfig(
      { baseUrl: 'https://api.test', headers: { 'X-By': '{{amcp.user_email}}' } },
      {
        method: 'POST',
        path: '/orgs/{{amcp.org_id}}/items',
        queryParams: { actor: '{{amcp.user_id}}' },
        bodyMapping: { requestedBy: '{{amcp.user_email}}' },
        headers: { 'X-Server': '{{amcp.server_name}}' },
      },
      { ...buildCallerContextVars(context) },
      opts,
    );
    expect(result.config.headers).toEqual({ 'X-By': 'dominik@example.com' });
    expect(result.endpointMapping.path).toBe('/orgs/org_1/items');
    expect(result.endpointMapping.queryParams).toEqual({ actor: 'usr_1' });
    expect(result.endpointMapping.bodyMapping).toEqual({
      requestedBy: 'dominik@example.com',
    });
    expect(result.endpointMapping.headers).toEqual({ 'X-Server': 'Prod' });
  });

  it('applies reserved vars even when the connector has no env vars', () => {
    const result = interpolateConnectorConfig(
      { baseUrl: 'https://api.test', headers: { 'X-By': '{{amcp.user_id}}' } },
      { method: 'GET', path: '/x' },
      buildCallerContextVars(context),
      opts,
    );
    expect(result.config.headers).toEqual({ 'X-By': 'usr_1' });
  });

  it('leaves values alone when the feature is not used', () => {
    const result = interpolateConnectorConfig(
      { baseUrl: 'https://api.test', headers: { 'X-Static': 'plain' } },
      { method: 'GET', path: '/x' },
      buildCallerContextVars(context),
      opts,
    );
    expect(result.config.headers).toEqual({ 'X-Static': 'plain' });
    expect(result.endpointMapping.path).toBe('/x');
  });
});

describe('usesCallerContext', () => {
  it('detects a reference', () => {
    expect(usesCallerContext('{{amcp.user_email}}')).toBe(true);
    expect(usesCallerContext('{{ amcp.user_id }}')).toBe(true);
  });

  it('ignores ordinary variables and non-strings', () => {
    expect(usesCallerContext('{{API_KEY}}')).toBe(false);
    expect(usesCallerContext(42)).toBe(false);
  });
});

describe('findUnknownCallerContextVars', () => {
  it('finds typos so a bad config can be rejected at save time', () => {
    expect(
      findUnknownCallerContextVars({ h: { a: '{{amcp.user_mail}}' } }),
    ).toEqual(['amcp.user_mail']);
  });

  it('accepts every documented variable', () => {
    const template = Object.keys(CALLER_CONTEXT_VARIABLES).map((k) => `{{${k}}}`);
    expect(findUnknownCallerContextVars(template)).toEqual([]);
  });

  it('ignores non-reserved variables', () => {
    expect(findUnknownCallerContextVars('{{ANYTHING}}')).toEqual([]);
  });

  it('deduplicates repeated typos', () => {
    expect(
      findUnknownCallerContextVars(['{{amcp.x}}', '{{amcp.x}}']),
    ).toEqual(['amcp.x']);
  });

  it('stays linear on adversarial brace runs', () => {
    // A looser pattern backtracks polynomially here (ReDoS). This scans
    // operator-supplied tool config, so it must not be exploitable.
    const evil = '{{{{'.repeat(20000);
    const started = Date.now();
    expect(findUnknownCallerContextVars(evil)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('tolerates unterminated placeholders', () => {
    expect(findUnknownCallerContextVars('{{amcp.user_email')).toEqual([]);
  });
});

describe('usesCallerContext repeated calls', () => {
  it('is stateless across calls', () => {
    // A /g regex reused with .test() would alternate true/false.
    const v = '{{amcp.user_email}}';
    expect(usesCallerContext(v)).toBe(true);
    expect(usesCallerContext(v)).toBe(true);
  });
});

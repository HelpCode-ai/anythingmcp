import {
  mcpFixedArgumentsOf,
  resolveMcpFixedArguments,
  withMcpFixedArguments,
  withoutMcpFixedArguments,
} from './mcp-connector-config.util';

/**
 * `connector.config.mcpFixedArguments`: arguments an MCP bridge sends with
 * every tool call (the agent profile URL a UCP shop asks for) and keeps out
 * of the schemas the model sees.
 */
const PROFILE = 'https://agent.example.test/.well-known/ucp-agent.json';
const FIXED = { meta: { 'ucp-agent': { profile: PROFILE } } };

/** `meta` as a UCP shop's tools declare it. */
const metaSchema = (extra: Record<string, unknown> = {}, extraRequired: string[] = []) => ({
  type: 'object',
  description: 'Metadata for UCP agent profile discovery.',
  properties: {
    'ucp-agent': {
      type: 'object',
      properties: { profile: { type: 'string', format: 'uri' } },
      required: ['profile'],
    },
    ...extra,
  },
  required: ['ucp-agent', ...extraRequired],
});

describe('mcpFixedArgumentsOf', () => {
  it('reads the object from the connector settings', () => {
    expect(mcpFixedArgumentsOf({ mcpToolPrefix: 'shop_', mcpFixedArguments: FIXED })).toBe(FIXED);
  });

  it('is undefined without the setting, and for anything that is not a non-empty object', () => {
    expect(mcpFixedArgumentsOf({ mcpToolPrefix: 'shop_' })).toBeUndefined();
    expect(mcpFixedArgumentsOf(null)).toBeUndefined();
    expect(mcpFixedArgumentsOf(undefined)).toBeUndefined();
    for (const value of [{}, [], ['meta'], 'meta', 7, true, null]) {
      expect(mcpFixedArgumentsOf({ mcpFixedArguments: value })).toBeUndefined();
    }
  });
});

describe('resolveMcpFixedArguments', () => {
  it('fills {{VAR}} from the connector variables, at any depth, without changing the setting', () => {
    const config = {
      mcpFixedArguments: { meta: { 'ucp-agent': { profile: '{{AGENT_PROFILE_URL}}' } }, channel: 'web-{{REGION}}', n: 3 },
    };
    expect(resolveMcpFixedArguments(config, { AGENT_PROFILE_URL: PROFILE, REGION: 'eu' })).toEqual({
      meta: { 'ucp-agent': { profile: PROFILE } },
      channel: 'web-eu',
      n: 3,
    });
    expect(config.mcpFixedArguments.meta['ucp-agent'].profile).toBe('{{AGENT_PROFILE_URL}}');
  });

  it('leaves a placeholder nobody set in place, for the caller to refuse', () => {
    const config = { mcpFixedArguments: { token: '{{NOT_SET}}' } };
    expect(resolveMcpFixedArguments(config, {})).toEqual({ token: '{{NOT_SET}}' });
    expect(resolveMcpFixedArguments(config, null)).toEqual({ token: '{{NOT_SET}}' });
  });

  it('is undefined for a connector without the setting', () => {
    expect(resolveMcpFixedArguments({ mcpToolPrefix: 'shop_' }, { A: 'b' })).toBeUndefined();
    expect(resolveMcpFixedArguments(undefined, undefined)).toBeUndefined();
  });
});

describe('withMcpFixedArguments', () => {
  it("returns the caller's own object when the connector fixes nothing", () => {
    const args = { q: 'tent' };
    expect(withMcpFixedArguments(args, undefined)).toBe(args);
  });

  it('adds the fixed arguments next to what the caller sent', () => {
    expect(withMcpFixedArguments({ catalog: { query: 'tent' } }, FIXED)).toEqual({
      catalog: { query: 'tent' },
      meta: { 'ucp-agent': { profile: PROFILE } },
    });
  });

  it('merges objects key by key, so the caller keeps its other fields', () => {
    const merged = withMcpFixedArguments(
      { id: 'chk_1', meta: { 'idempotency-key': 'k-1', 'ucp-agent': { note: 'kept' } } },
      FIXED,
    );
    expect(merged).toEqual({
      id: 'chk_1',
      meta: { 'idempotency-key': 'k-1', 'ucp-agent': { note: 'kept', profile: PROFILE } },
    });
  });

  it('lets the fixed value win at every path it names', () => {
    expect(
      withMcpFixedArguments({ meta: { 'ucp-agent': { profile: 'https://evil.example.test/p.json' } } }, FIXED),
    ).toEqual(FIXED);
    // The caller sent something that is not an object where an object is fixed.
    expect(withMcpFixedArguments({ meta: 'none' }, FIXED)).toEqual(FIXED);
    expect(withMcpFixedArguments({ meta: { 'ucp-agent': ['x'] } }, FIXED)).toEqual(FIXED);
    // Plain values and arrays are replaced as a whole.
    expect(withMcpFixedArguments({ tags: ['a', 'b'], limit: 500 }, { tags: ['fixed'], limit: 10 })).toEqual({
      tags: ['fixed'],
      limit: 10,
    });
  });

  it('changes neither the arguments nor the setting', () => {
    const args = { meta: { 'idempotency-key': 'k-1' } };
    const fixed = { meta: { 'ucp-agent': { profile: PROFILE } } };
    const merged = withMcpFixedArguments(args, fixed);
    expect(args).toEqual({ meta: { 'idempotency-key': 'k-1' } });
    expect(fixed).toEqual({ meta: { 'ucp-agent': { profile: PROFILE } } });
    expect(merged.meta).not.toBe(fixed.meta);
    (merged.meta as Record<string, unknown>).added = true;
    expect(fixed.meta).not.toHaveProperty('added');
  });

  it('never copies a prototype key from the setting', () => {
    const fixed = JSON.parse('{"__proto__": {"polluted": true}, "constructor": {"x": 1}, "ok": 1}');
    const merged = withMcpFixedArguments({}, fixed);
    expect(merged).toEqual({ ok: 1 });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
  });
});

describe('withoutMcpFixedArguments', () => {
  it('returns the schema itself when the connector fixes nothing, or nothing it lists', () => {
    const schema = { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] };
    expect(withoutMcpFixedArguments(schema, undefined)).toBe(schema);
    expect(withoutMcpFixedArguments(schema, FIXED)).toBe(schema);
    const bare = { type: 'object' };
    expect(withoutMcpFixedArguments(bare, FIXED)).toBe(bare);
  });

  it('drops a fixed top-level parameter, also from required', () => {
    const schema = {
      type: 'object',
      properties: { q: { type: 'string' }, channel: { type: 'string' }, limit: { type: 'integer' } },
      required: ['q', 'channel'],
      additionalProperties: false,
    };
    expect(withoutMcpFixedArguments(schema, { channel: 'web', limit: 10 })).toEqual({
      type: 'object',
      properties: { q: { type: 'string' } },
      required: ['q'],
      additionalProperties: false,
    });
    // The server's own object is not changed.
    expect(Object.keys(schema.properties)).toEqual(['q', 'channel', 'limit']);
    expect(schema.required).toEqual(['q', 'channel']);
  });

  it('drops the whole parameter when the fixed path was all it held (meta.ucp-agent.profile)', () => {
    const schema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { meta: metaSchema(), catalog: { type: 'object', properties: { query: { type: 'string' } } } },
      required: ['meta', 'catalog'],
    };
    expect(withoutMcpFixedArguments(schema, FIXED)).toEqual({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { catalog: { type: 'object', properties: { query: { type: 'string' } } } },
      required: ['catalog'],
    });
    expect(schema.properties.meta.properties).toHaveProperty('ucp-agent');
  });

  it('keeps a parameter that holds more, without the fixed part (meta.idempotency-key)', () => {
    const schema = {
      type: 'object',
      properties: {
        meta: metaSchema({ 'idempotency-key': { type: 'string', description: 'Key' } }, ['idempotency-key']),
        id: { type: 'string' },
      },
      required: ['meta', 'id'],
    };
    expect(withoutMcpFixedArguments(schema, FIXED)).toEqual({
      type: 'object',
      properties: {
        meta: {
          type: 'object',
          description: 'Metadata for UCP agent profile discovery.',
          properties: { 'idempotency-key': { type: 'string', description: 'Key' } },
          required: ['idempotency-key'],
        },
        id: { type: 'string' },
      },
      required: ['meta', 'id'],
    });
  });

  it('keeps the other fields of the innermost object too', () => {
    const schema = {
      type: 'object',
      properties: {
        meta: {
          type: 'object',
          properties: {
            'ucp-agent': {
              type: 'object',
              properties: { profile: { type: 'string' }, locale: { type: 'string' } },
              required: ['profile'],
            },
          },
          required: ['ucp-agent'],
        },
      },
      required: ['meta'],
    };
    expect(withoutMcpFixedArguments(schema, FIXED)).toEqual({
      type: 'object',
      properties: {
        meta: {
          type: 'object',
          properties: { 'ucp-agent': { type: 'object', properties: { locale: { type: 'string' } }, required: [] } },
          required: ['ucp-agent'],
        },
      },
      required: ['meta'],
    });
  });

  it('drops a free-form object that is fixed, and leaves one it cannot see into', () => {
    const schema = {
      type: 'object',
      properties: {
        meta: { type: 'object', additionalProperties: true },
        byRef: { $ref: '#/$defs/meta' },
        byUnion: { anyOf: [{ type: 'object' }, { type: 'null' }] },
        q: { type: 'string' },
      },
      required: ['meta', 'byRef', 'q'],
    };
    const fixed = { meta: { a: 1 }, byRef: { a: 1 }, byUnion: { a: 1 } };
    expect(withoutMcpFixedArguments(schema, fixed)).toEqual({
      type: 'object',
      properties: {
        byRef: { $ref: '#/$defs/meta' },
        byUnion: { anyOf: [{ type: 'object' }, { type: 'null' }] },
        q: { type: 'string' },
      },
      required: ['byRef', 'q'],
    });
  });

  it('takes a fixed name out of required even when the schema does not describe it', () => {
    const schema = { type: 'object', properties: { q: { type: 'string' } }, required: ['q', 'meta'] };
    expect(withoutMcpFixedArguments(schema, FIXED)).toEqual({
      type: 'object',
      properties: { q: { type: 'string' } },
      required: ['q'],
    });
  });

  it('needs only the shape of the setting: values may still hold {{VAR}}', () => {
    const schema = { type: 'object', properties: { meta: metaSchema(), q: { type: 'string' } }, required: ['meta'] };
    expect(
      withoutMcpFixedArguments(schema, { meta: { 'ucp-agent': { profile: '{{AGENT_PROFILE_URL}}' } } }),
    ).toEqual({ type: 'object', properties: { q: { type: 'string' } }, required: [] });
  });
});

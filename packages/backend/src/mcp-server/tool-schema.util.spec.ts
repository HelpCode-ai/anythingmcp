import { z } from 'zod';
import {
  flattenToolSchema,
  jsonSchemaToZodShape,
  stripEnvVarParams,
  toolSchemaProperties,
} from './tool-schema.util';

// One resource from a list, one with its own configuration, or several at once:
// the shape of a vendor MCP server that puts its alternatives under `oneOf`.
const provision = {
  type: 'object',
  oneOf: [
    {
      type: 'object',
      required: ['tenant_id', 'resource', 'confirmed'],
      properties: {
        tenant_id: { type: 'string', description: 'Tenant id.' },
        resource: { type: 'string', enum: ['redis', 'object-storage'] },
        confirmed: { type: 'boolean' },
      },
    },
    {
      type: 'object',
      required: ['tenant_id', 'resource', 'confirmed'],
      properties: {
        tenant_id: { type: 'string', description: 'Tenant id.' },
        resource: { type: 'string', const: 'postgres' },
        configuration: { type: 'object' },
        confirmed: { type: 'boolean' },
      },
    },
    {
      type: 'object',
      required: ['tenant_id', 'resources', 'confirmed'],
      properties: {
        tenant_id: { type: 'string', description: 'Tenant id.' },
        resources: { type: 'array', items: { type: 'string' } },
        confirmed: { type: 'boolean' },
      },
    },
  ],
};

const parse = (schema: Record<string, unknown>, args: Record<string, unknown>) =>
  z.object(jsonSchemaToZodShape(schema)).parse(args);

describe('toolSchemaProperties', () => {
  it('returns the properties of a plain object schema unchanged', () => {
    const schema = { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] };
    expect(toolSchemaProperties(schema)).toEqual({ properties: schema.properties, required: ['q'] });
  });

  it('merges the branches of a top-level oneOf', () => {
    const { properties, required } = toolSchemaProperties(provision);
    expect(Object.keys(properties!).sort()).toEqual(
      ['configuration', 'confirmed', 'resource', 'resources', 'tenant_id'].sort(),
    );
    expect(properties!.resource.enum).toEqual(['redis', 'object-storage', 'postgres']);
    expect(properties!.tenant_id.description).toBe('Tenant id.');
    expect(required.sort()).toEqual(['confirmed', 'tenant_id']);
  });

  it('drops the value list when one branch leaves the property open', () => {
    const { properties } = toolSchemaProperties({
      anyOf: [
        { properties: { mode: { type: 'string', enum: ['a'] } } },
        { properties: { mode: { type: 'string' } } },
      ],
    });
    expect(properties!.mode).toEqual({ type: 'string' });
  });

  it('adds branch-only properties to the top-level ones', () => {
    const { properties, required } = toolSchemaProperties({
      type: 'object',
      properties: { account: { type: 'string', description: 'Account id.' } },
      required: ['account'],
      anyOf: [
        { properties: { email: { type: 'string' } }, required: ['email'] },
        { properties: { phone: { type: 'string' } }, required: ['phone'] },
      ],
    });
    expect(Object.keys(properties!).sort()).toEqual(['account', 'email', 'phone']);
    expect(properties!.account).toEqual({ type: 'string', description: 'Account id.' });
    expect(required).toEqual(['account']);
  });

  it('keeps the top-level definition of a property a branch also declares', () => {
    const { properties } = toolSchemaProperties({
      properties: { mode: { type: 'string', default: 'fast' } },
      oneOf: [{ properties: { mode: { type: 'string', enum: ['fast'] } } }],
    });
    expect(properties!.mode).toEqual({ type: 'string', default: 'fast' });
  });

  it('unions the properties and the required keys of a top-level allOf', () => {
    const { properties, required } = toolSchemaProperties({
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      allOf: [
        { properties: { name: { type: 'string' } }, required: ['name'] },
        { properties: { size: { type: 'integer', default: 10 } } },
      ],
    });
    expect(Object.keys(properties!).sort()).toEqual(['id', 'name', 'size']);
    // allOf applies to every call, so its defaults stay.
    expect(properties!.size).toEqual({ type: 'integer', default: 10 });
    expect(required.sort()).toEqual(['id', 'name']);
  });

  it('reads a oneOf nested inside an allOf part', () => {
    const { properties, required } = toolSchemaProperties({
      allOf: [
        { properties: { id: { type: 'string' } }, required: ['id'] },
        {
          oneOf: [
            { properties: { a: { type: 'string' } }, required: ['a'] },
            { properties: { b: { type: 'string' } }, required: ['b'] },
          ],
        },
      ],
    });
    expect(Object.keys(properties!).sort()).toEqual(['a', 'b', 'id']);
    expect(required).toEqual(['id']);
  });

  it('requires a key only when every branch requires it', () => {
    const { required } = toolSchemaProperties({
      properties: { tenant_id: { type: 'string' } },
      oneOf: [
        { required: ['tenant_id', 'x'], properties: { x: { type: 'string' } } },
        { required: ['tenant_id'], properties: { y: { type: 'string' } } },
      ],
    });
    expect(required).toEqual(['tenant_id']);
  });

  it('drops the type when two branches give a property different types', () => {
    const { properties } = toolSchemaProperties({
      oneOf: [
        { properties: { id: { type: 'string', description: 'Id or number.' } } },
        { properties: { id: { type: 'integer' } } },
      ],
    });
    expect(properties!.id).toEqual({ description: 'Id or number.' });
  });

  it('omits a default that only a branch declares', () => {
    const { properties } = toolSchemaProperties({
      oneOf: [
        { properties: { extension: { type: 'string', default: 'txt' } } },
        { properties: { data: { type: 'string' } } },
      ],
    });
    expect(properties!.extension).toEqual({ type: 'string' });
  });
});

describe('flattenToolSchema', () => {
  it('returns a schema without a combinator as is', () => {
    const schema = { type: 'object', properties: { q: { type: 'string' } } };
    expect(flattenToolSchema(schema)).toBe(schema);
  });

  it('replaces a top-level oneOf with plain properties and required', () => {
    const flat = flattenToolSchema(provision);
    expect(flat.oneOf).toBeUndefined();
    expect(flat.type).toBe('object');
    expect(Object.keys(flat.properties as object).sort()).toEqual(
      ['configuration', 'confirmed', 'resource', 'resources', 'tenant_id'].sort(),
    );
    expect((flat.required as string[]).sort()).toEqual(['confirmed', 'tenant_id']);
  });
});

describe('stripEnvVarParams with combinators', () => {
  it('removes an env-covered key inside a branch and does not require it', () => {
    const out = stripEnvVarParams(
      {
        type: 'object',
        oneOf: [
          { properties: { api_key: { type: 'string' }, q: { type: 'string' } }, required: ['api_key', 'q'] },
          { properties: { api_key: { type: 'string' }, id: { type: 'string' } }, required: ['api_key'] },
        ],
      },
      { api_key: 'secret' },
    );
    expect(out.oneOf).toBeUndefined();
    expect(Object.keys(out.properties as object).sort()).toEqual(['id', 'q']);
    expect(out.required).toBeUndefined();
  });

  it('removes an env-covered key of an allOf part from properties and required', () => {
    const out = stripEnvVarParams(
      {
        properties: { q: { type: 'string' } },
        required: ['q'],
        allOf: [{ properties: { region: { type: 'string' } }, required: ['region'] }],
      },
      { region: 'eu' },
    );
    expect(Object.keys(out.properties as object)).toEqual(['q']);
    expect(out.required).toEqual(['q']);
  });

  it('drops `required` when every required key is env-covered', () => {
    const out = stripEnvVarParams(
      { type: 'object', properties: { token: { type: 'string' }, q: { type: 'string' } }, required: ['token'] },
      { token: 't' },
    );
    expect(out).toEqual({ type: 'object', properties: { q: { type: 'string' } } });
  });
});

describe('jsonSchemaToZodShape with top-level combinators', () => {
  it('keeps the arguments of every branch instead of stripping them', () => {
    const args = {
      tenant_id: 't-1',
      resource: 'postgres',
      configuration: { region: 'eu' },
      confirmed: true,
    };
    expect(parse(provision, args)).toEqual(args);
  });

  it('keeps a branch-only argument next to top-level properties', () => {
    const schema = {
      type: 'object',
      properties: { account: { type: 'string' } },
      required: ['account'],
      oneOf: [
        { properties: { email: { type: 'string' } }, required: ['email'] },
        { properties: { phone: { type: 'string' } }, required: ['phone'] },
      ],
    };
    expect(parse(schema, { account: 'a', phone: '+49' })).toEqual({ account: 'a', phone: '+49' });
  });

  it('accepts the value of a later branch when the types differ', () => {
    const schema = {
      oneOf: [
        { properties: { id: { type: 'string' } }, required: ['id'] },
        { properties: { id: { type: 'integer' } }, required: ['id'] },
      ],
    };
    expect(parse(schema, { id: 42 })).toEqual({ id: 42 });
    expect(parse(schema, { id: 'x' })).toEqual({ id: 'x' });
  });

  it('enforces a key required by an allOf part', () => {
    const schema = {
      allOf: [
        { properties: { name: { type: 'string' } }, required: ['name'] },
        { properties: { note: { type: 'string' } } },
      ],
    };
    expect(() => parse(schema, { note: 'n' })).toThrow();
    expect(parse(schema, { name: 'n' })).toEqual({ name: 'n' });
  });

  // Reproduced in the review of #961: a branch-local default applied to a call
  // for another branch adds an argument that branch forbids.
  it('does not apply a branch-local default to a call for another branch', () => {
    const schema = {
      type: 'object',
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['kind'],
          properties: {
            kind: { type: 'string', enum: ['text'] },
            extension: { type: 'string', default: 'txt' },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'data'],
          properties: {
            kind: { type: 'string', enum: ['binary'] },
            data: { type: 'string' },
          },
        },
      ],
    };
    expect(parse(schema, { kind: 'binary', data: 'AA==' })).toEqual({ kind: 'binary', data: 'AA==' });
    expect(parse(schema, { kind: 'text' })).toEqual({ kind: 'text' });
  });
});

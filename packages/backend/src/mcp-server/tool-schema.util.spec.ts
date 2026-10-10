import { z } from 'zod';
import { jsonSchemaToZodShape, toolSchemaProperties } from './tool-schema.util';

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
});

describe('jsonSchemaToZodShape with a top-level oneOf', () => {
  it('keeps the arguments of every branch instead of stripping them', () => {
    const parsed = z.object(jsonSchemaToZodShape(provision)).parse({
      tenant_id: 't-1',
      resource: 'postgres',
      configuration: { region: 'eu' },
      confirmed: true,
    });
    expect(parsed).toEqual({
      tenant_id: 't-1',
      resource: 'postgres',
      configuration: { region: 'eu' },
      confirmed: true,
    });
  });
});

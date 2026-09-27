import { applySchemaDefaults } from './schema-defaults.util';

describe('applySchemaDefaults', () => {
  const schema = {
    type: 'object',
    properties: {
      name: { type: 'string', default: '%' },
      limit: { type: 'integer', default: 200 },
      flag: { type: 'boolean', default: false },
      id: { type: 'string' },
    },
  };

  it('fills only the parameters the caller left undefined', () => {
    expect(applySchemaDefaults(schema, { id: 'a', limit: 5 })).toEqual({
      id: 'a',
      limit: 5,
      name: '%',
      flag: false,
    });
  });

  it('leaves an explicit empty string or null alone', () => {
    expect(applySchemaDefaults(schema, { name: '', limit: null })).toMatchObject({
      name: '',
      limit: null,
    });
  });

  it('does not mutate the caller object', () => {
    const params = { id: 'a' };
    applySchemaDefaults(schema, params);
    expect(params).toEqual({ id: 'a' });
  });

  it.each([undefined, null, {}, { properties: null }, 'x'])(
    'returns the params unchanged for schema %p',
    (s) => {
      const params = { id: 'a' };
      expect(applySchemaDefaults(s, params)).toBe(params);
    },
  );
});

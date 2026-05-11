import { normalizeOpenApi31 } from './openapi-3.1-normalizer';

describe('normalizeOpenApi31', () => {
  it('rewrites type: ["string","null"] to type: "string" + nullable: true', () => {
    const spec = {
      components: {
        schemas: {
          User: { type: ['string', 'null'] },
        },
      },
    };
    normalizeOpenApi31(spec);
    expect(spec.components.schemas.User).toEqual({ type: 'string', nullable: true });
  });

  it('keeps a single non-null type when the array contains only null + one type', () => {
    const spec = { type: ['integer', 'null'] };
    normalizeOpenApi31(spec);
    expect(spec).toEqual({ type: 'integer', nullable: true });
  });

  it('falls back to the first non-null type for multi-type unions with null', () => {
    const spec = { type: ['string', 'number', 'null'] };
    normalizeOpenApi31(spec);
    // 3.0 has no union types — lossy but better than rejection.
    expect(spec).toEqual({ type: 'string', nullable: true });
  });

  it('unwraps anyOf: [X, {type:"null"}] into the X branch with nullable: true', () => {
    const spec = {
      properties: {
        email: { anyOf: [{ type: 'string', format: 'email' }, { type: 'null' }] },
      },
    };
    normalizeOpenApi31(spec);
    expect(spec.properties.email).toEqual({
      type: 'string',
      format: 'email',
      nullable: true,
    });
  });

  it('keeps anyOf when there is more than one non-null branch (sets nullable)', () => {
    const spec = {
      properties: {
        value: {
          anyOf: [
            { type: 'string' },
            { type: 'integer' },
            { type: 'null' },
          ],
        },
      },
    };
    normalizeOpenApi31(spec);
    expect(spec.properties.value).toEqual({
      anyOf: [{ type: 'string' }, { type: 'integer' }],
      nullable: true,
    });
  });

  it('handles oneOf with a null member the same way as anyOf', () => {
    const spec = { oneOf: [{ type: 'boolean' }, { type: 'null' }] };
    normalizeOpenApi31(spec);
    expect(spec).toEqual({ type: 'boolean', nullable: true });
  });

  it('rewrites const to a single-value enum', () => {
    const spec = { const: 'active' };
    normalizeOpenApi31(spec);
    expect(spec).toEqual({ enum: ['active'] });
  });

  it('does not clobber an existing enum when const is also present', () => {
    const spec = { const: 'active', enum: ['active', 'inactive'] };
    normalizeOpenApi31(spec);
    // We respect the explicit enum and leave const alone.
    expect(spec).toEqual({ const: 'active', enum: ['active', 'inactive'] });
  });

  it('rewrites examples (plural array) to example (singular, first value)', () => {
    const spec = {
      properties: { name: { type: 'string', examples: ['Alice', 'Bob'] } },
    };
    normalizeOpenApi31(spec);
    expect(spec.properties.name).toEqual({ type: 'string', example: 'Alice' });
  });

  it('preserves the components.examples map (object, not array)', () => {
    const spec = {
      components: {
        examples: {
          alice: { value: 'Alice' },
          bob: { value: 'Bob' },
        },
      },
    };
    normalizeOpenApi31(spec);
    // Components map untouched — it's an object, not an array.
    expect(spec.components.examples).toEqual({
      alice: { value: 'Alice' },
      bob: { value: 'Bob' },
    });
  });

  it('converts numeric exclusiveMinimum/Maximum (3.1) to boolean form (3.0)', () => {
    const spec = { exclusiveMinimum: 0, exclusiveMaximum: 100 };
    normalizeOpenApi31(spec);
    expect(spec).toEqual({
      minimum: 0,
      exclusiveMinimum: true,
      maximum: 100,
      exclusiveMaximum: true,
    });
  });

  it('combines multiple transformations in a realistic FastAPI-style spec', () => {
    const spec: any = {
      paths: {
        '/items/{id}': {
          get: {
            parameters: [
              {
                name: 'id',
                in: 'path',
                required: true,
                schema: { type: ['integer', 'null'], exclusiveMinimum: 0 },
              },
            ],
            responses: {
              '200': {
                content: {
                  'application/json': {
                    schema: {
                      properties: {
                        status: { const: 'available' },
                        email: {
                          anyOf: [
                            { type: 'string', format: 'email' },
                            { type: 'null' },
                          ],
                        },
                        tags: {
                          type: ['array', 'null'],
                          items: { type: 'string', examples: ['urgent'] },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    normalizeOpenApi31(spec);

    const op = spec.paths['/items/{id}'].get;
    expect(op.parameters[0].schema).toEqual({
      type: 'integer',
      nullable: true,
      minimum: 0,
      exclusiveMinimum: true,
    });

    const body =
      op.responses['200'].content['application/json'].schema.properties;
    expect(body.status).toEqual({ enum: ['available'] });
    expect(body.email).toEqual({
      type: 'string',
      format: 'email',
      nullable: true,
    });
    expect(body.tags.type).toBe('array');
    expect(body.tags.nullable).toBe(true);
    expect(body.tags.items).toEqual({ type: 'string', example: 'urgent' });
  });

  it('returns the same reference (mutates in place)', () => {
    const spec = { const: 'x' };
    const result = normalizeOpenApi31(spec);
    expect(result).toBe(spec);
  });

  it('relabels openapi: 3.1.x to 3.0.3 so swagger-parser accepts it', () => {
    const spec: any = { openapi: '3.1.0', info: { title: 'X', version: '1' }, paths: {} };
    normalizeOpenApi31(spec);
    expect(spec.openapi).toBe('3.0.3');
  });

  it('leaves openapi version alone on a 3.0 spec passed in', () => {
    const spec: any = { openapi: '3.0.2', info: { title: 'X', version: '1' }, paths: {} };
    normalizeOpenApi31(spec);
    expect(spec.openapi).toBe('3.0.2');
  });

  it('is a no-op on a 3.0-style spec', () => {
    const spec = {
      type: 'string',
      nullable: true,
      enum: ['a', 'b'],
      example: 'a',
    };
    const before = JSON.stringify(spec);
    normalizeOpenApi31(spec);
    expect(JSON.stringify(spec)).toBe(before);
  });
});

import { OpenApiParser } from './openapi.parser';

describe('OpenApiParser', () => {
  let parser: OpenApiParser;

  beforeEach(() => {
    parser = new OpenApiParser();
  });

  const minimalSpec = {
    openapi: '3.0.0',
    info: { title: 'Test API', version: '1.0.0' },
    paths: {},
  };

  // ── Basics ──────────────────────────────────────────────────────────────

  it('should parse an empty spec', async () => {
    const tools = await parser.parse(minimalSpec);
    expect(tools).toHaveLength(0);
  });

  it('should parse from JSON string', async () => {
    const tools = await parser.parse(JSON.stringify(minimalSpec));
    expect(tools).toHaveLength(0);
  });

  // ── GET endpoints ──────────────────────────────────────────────────────

  it('should parse a simple GET endpoint', async () => {
    const spec = {
      ...minimalSpec,
      paths: {
        '/users': {
          get: {
            operationId: 'listUsers',
            summary: 'List all users',
            parameters: [],
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };
    const tools = await parser.parse(spec);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('listusers');
    expect(tools[0].description).toBe('List all users');
    expect(tools[0].endpointMapping.method).toBe('GET');
    expect(tools[0].endpointMapping.path).toBe('/users');
  });

  it('should parse GET with path parameters', async () => {
    const spec = {
      ...minimalSpec,
      paths: {
        '/users/{id}': {
          get: {
            operationId: 'getUser',
            summary: 'Get a user by ID',
            parameters: [
              {
                name: 'id',
                in: 'path',
                required: true,
                schema: { type: 'string' },
                description: 'User ID',
              },
            ],
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };
    const tools = await parser.parse(spec);
    expect(tools).toHaveLength(1);
    expect(tools[0].endpointMapping.path).toBe('/users/{id}');
    const params = tools[0].parameters as any;
    expect(params.properties.id).toBeDefined();
    expect(params.properties.id.description).toBe('User ID');
    expect(params.required).toContain('id');
  });

  it('should parse GET with query parameters', async () => {
    const spec = {
      ...minimalSpec,
      paths: {
        '/search': {
          get: {
            operationId: 'search',
            summary: 'Search items',
            parameters: [
              {
                name: 'q',
                in: 'query',
                required: true,
                schema: { type: 'string' },
                description: 'Search query',
              },
              {
                name: 'limit',
                in: 'query',
                required: false,
                schema: { type: 'integer', default: 10 },
                description: 'Max results',
              },
            ],
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };
    const tools = await parser.parse(spec);
    expect(tools).toHaveLength(1);
    const params = tools[0].parameters as any;
    expect(params.properties.q).toBeDefined();
    expect(params.required).toContain('q');
    expect(params.properties.limit).toBeDefined();
    expect(params.properties.limit.default).toBe(10);
    expect(tools[0].endpointMapping.queryParams!['q']).toBe('$q');
    expect(tools[0].endpointMapping.queryParams!['limit']).toBe('$limit');
  });

  // ── POST endpoints ────────────────────────────────────────────────────

  it('should parse POST with request body', async () => {
    const spec = {
      ...minimalSpec,
      paths: {
        '/users': {
          post: {
            operationId: 'createUser',
            summary: 'Create a new user',
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      name: { type: 'string', description: 'User name' },
                      email: { type: 'string', format: 'email', description: 'Email address' },
                    },
                    required: ['name', 'email'],
                  },
                },
              },
            },
            responses: { '201': { description: 'Created' } },
          },
        },
      },
    };
    const tools = await parser.parse(spec);
    expect(tools).toHaveLength(1);
    expect(tools[0].endpointMapping.method).toBe('POST');
    const params = tools[0].parameters as any;
    expect(params.properties.name).toBeDefined();
    expect(params.properties.email).toBeDefined();
    expect(params.required).toContain('name');
    expect(params.required).toContain('email');
    expect(tools[0].endpointMapping.bodyMapping!['name']).toBe('$name');
    expect(tools[0].endpointMapping.bodyMapping!['email']).toBe('$email');
  });

  it('should parse POST with form-urlencoded body', async () => {
    const spec = {
      ...minimalSpec,
      paths: {
        '/auth/token': {
          post: {
            operationId: 'getToken',
            summary: 'Get access token',
            requestBody: {
              content: {
                'application/x-www-form-urlencoded': {
                  schema: {
                    type: 'object',
                    properties: {
                      grant_type: { type: 'string' },
                      client_id: { type: 'string' },
                    },
                    required: ['grant_type'],
                  },
                },
              },
            },
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };
    const tools = await parser.parse(spec);
    expect(tools).toHaveLength(1);
    const params = tools[0].parameters as any;
    expect(params.properties.grant_type).toBeDefined();
    expect(params.required).toContain('grant_type');
    expect(tools[0].endpointMapping.bodyMapping!['grant_type']).toBe('$grant_type');
  });

  // ── PUT / PATCH / DELETE ──────────────────────────────────────────────

  it('should parse PUT endpoint', async () => {
    const spec = {
      ...minimalSpec,
      paths: {
        '/users/{id}': {
          put: {
            operationId: 'updateUser',
            summary: 'Update a user',
            parameters: [
              { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            ],
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                    },
                  },
                },
              },
            },
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };
    const tools = await parser.parse(spec);
    expect(tools).toHaveLength(1);
    expect(tools[0].endpointMapping.method).toBe('PUT');
    expect(tools[0].endpointMapping.path).toBe('/users/{id}');
    const params = tools[0].parameters as any;
    expect(params.properties.id).toBeDefined();
    expect(params.properties.name).toBeDefined();
    expect(params.required).toContain('id');
    expect(tools[0].endpointMapping.bodyMapping!['name']).toBe('$name');
  });

  it('should parse DELETE endpoint', async () => {
    const spec = {
      ...minimalSpec,
      paths: {
        '/users/{id}': {
          delete: {
            operationId: 'deleteUser',
            summary: 'Delete a user',
            parameters: [
              { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            ],
            responses: { '204': { description: 'No Content' } },
          },
        },
      },
    };
    const tools = await parser.parse(spec);
    expect(tools).toHaveLength(1);
    expect(tools[0].endpointMapping.method).toBe('DELETE');
    expect(tools[0].endpointMapping.path).toBe('/users/{id}');
    const params = tools[0].parameters as any;
    expect(params.required).toContain('id');
  });

  it('should parse PATCH endpoint', async () => {
    const spec = {
      ...minimalSpec,
      paths: {
        '/users/{id}': {
          patch: {
            operationId: 'patchUser',
            summary: 'Partially update a user',
            parameters: [
              { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            ],
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      email: { type: 'string', format: 'email' },
                    },
                  },
                },
              },
            },
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };
    const tools = await parser.parse(spec);
    expect(tools).toHaveLength(1);
    expect(tools[0].endpointMapping.method).toBe('PATCH');
    expect(tools[0].endpointMapping.bodyMapping!['email']).toBe('$email');
  });

  // ── Multiple endpoints ────────────────────────────────────────────────

  it('should parse multiple endpoints from same path', async () => {
    const spec = {
      ...minimalSpec,
      paths: {
        '/users': {
          get: {
            operationId: 'listUsers',
            summary: 'List users',
            responses: { '200': { description: 'OK' } },
          },
          post: {
            operationId: 'createUser',
            summary: 'Create user',
            responses: { '201': { description: 'Created' } },
          },
        },
      },
    };
    const tools = await parser.parse(spec);
    expect(tools).toHaveLength(2);
    expect(tools[0].endpointMapping.method).toBe('GET');
    expect(tools[1].endpointMapping.method).toBe('POST');
  });

  it('should parse multiple paths', async () => {
    const spec = {
      ...minimalSpec,
      paths: {
        '/users': {
          get: {
            operationId: 'listUsers',
            summary: 'List users',
            responses: { '200': { description: 'OK' } },
          },
        },
        '/orders': {
          get: {
            operationId: 'listOrders',
            summary: 'List orders',
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };
    const tools = await parser.parse(spec);
    expect(tools).toHaveLength(2);
  });

  // ── Tool name generation ──────────────────────────────────────────────

  it('should use operationId for tool name when available', async () => {
    const spec = {
      ...minimalSpec,
      paths: {
        '/users': {
          get: {
            operationId: 'listAllActiveUsers',
            summary: 'List users',
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };
    const tools = await parser.parse(spec);
    expect(tools[0].name).toBe('listallactiveusers');
  });

  it('should generate tool name from method+path when no operationId', async () => {
    const spec = {
      ...minimalSpec,
      paths: {
        '/api/users': {
          get: {
            summary: 'List users',
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };
    const tools = await parser.parse(spec);
    expect(tools[0].name).toMatch(/get_.*api.*users/);
  });

  // ── Description ───────────────────────────────────────────────────────

  it('should combine summary and description', async () => {
    const spec = {
      ...minimalSpec,
      paths: {
        '/users': {
          get: {
            operationId: 'listUsers',
            summary: 'List all users',
            description: 'Returns a paginated list of all users in the system',
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };
    const tools = await parser.parse(spec);
    expect(tools[0].description).toContain('List all users');
    expect(tools[0].description).toContain('paginated list');
  });

  // ── Header parameters ────────────────────────────────────────────────

  it('should parse non-auth header parameters', async () => {
    const spec = {
      ...minimalSpec,
      paths: {
        '/data': {
          get: {
            operationId: 'getData',
            summary: 'Get data',
            parameters: [
              {
                name: 'X-Request-ID',
                in: 'header',
                required: true,
                schema: { type: 'string' },
                description: 'Unique request identifier',
              },
            ],
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };
    const tools = await parser.parse(spec);
    expect(tools).toHaveLength(1);
    const params = tools[0].parameters as any;
    expect(params.properties['X-Request-ID']).toBeDefined();
    expect(params.required).toContain('X-Request-ID');
  });

  it('should skip authorization and content-type header parameters', async () => {
    const spec = {
      ...minimalSpec,
      paths: {
        '/data': {
          get: {
            operationId: 'getData',
            summary: 'Get data',
            parameters: [
              { name: 'Authorization', in: 'header', schema: { type: 'string' } },
              { name: 'Content-Type', in: 'header', schema: { type: 'string' } },
              { name: 'X-Custom', in: 'header', required: true, schema: { type: 'string' } },
            ],
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };
    const tools = await parser.parse(spec);
    const params = tools[0].parameters as any;
    expect(params.properties['Authorization']).toBeUndefined();
    expect(params.properties['Content-Type']).toBeUndefined();
    expect(params.properties['X-Custom']).toBeDefined();
  });

  // ── Schema with enums and formats ──────────────────────────────────────

  it('should preserve enum and format from schema', async () => {
    const spec = {
      ...minimalSpec,
      paths: {
        '/users': {
          get: {
            operationId: 'listUsers',
            summary: 'List users',
            parameters: [
              {
                name: 'status',
                in: 'query',
                schema: { type: 'string', enum: ['active', 'inactive', 'pending'] },
              },
              {
                name: 'created_after',
                in: 'query',
                schema: { type: 'string', format: 'date-time' },
              },
            ],
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };
    const tools = await parser.parse(spec);
    const params = tools[0].parameters as any;
    expect(params.properties.status.enum).toEqual(['active', 'inactive', 'pending']);
    expect(params.properties.created_after.format).toBe('date-time');
  });
});

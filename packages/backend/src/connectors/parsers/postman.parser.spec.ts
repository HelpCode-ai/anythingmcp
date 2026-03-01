import { PostmanParser } from './postman.parser';

describe('PostmanParser', () => {
  let parser: PostmanParser;

  beforeEach(() => {
    parser = new PostmanParser();
  });

  const minimalCollection = {
    info: { name: 'Test Collection', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/' },
    item: [],
  };

  // ── Basics ──────────────────────────────────────────────────────────────

  it('should parse an empty collection', async () => {
    const tools = await parser.parse(minimalCollection);
    expect(tools).toHaveLength(0);
  });

  it('should parse from JSON string', async () => {
    const tools = await parser.parse(JSON.stringify(minimalCollection));
    expect(tools).toHaveLength(0);
  });

  it('should reject invalid JSON string', async () => {
    await expect(parser.parse('not json')).rejects.toThrow('Invalid Postman Collection JSON');
  });

  it('should reject collection without info.name', async () => {
    await expect(parser.parse({ info: {} } as any)).rejects.toThrow('missing info.name');
  });

  // ── REST GET ────────────────────────────────────────────────────────────

  it('should parse a simple GET request', async () => {
    const collection = {
      ...minimalCollection,
      item: [
        {
          name: 'Get Users',
          request: {
            method: 'GET',
            url: { raw: 'https://api.example.com/users', path: ['users'], query: [] },
          },
        },
      ],
    };
    const tools = await parser.parse(collection);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('get_users');
    expect(tools[0].endpointMapping.method).toBe('GET');
    expect(tools[0].endpointMapping.path).toBe('/users');
  });

  it('should handle query parameters', async () => {
    const collection = {
      ...minimalCollection,
      item: [
        {
          name: 'Search',
          request: {
            method: 'GET',
            url: {
              raw: 'https://api.example.com/search?q=test&limit=10',
              path: ['search'],
              query: [
                { key: 'q', value: 'test', description: 'Search query' },
                { key: 'limit', value: '10', description: 'Max results' },
              ],
            },
          },
        },
      ],
    };
    const tools = await parser.parse(collection);
    expect(tools).toHaveLength(1);
    expect(tools[0].endpointMapping.queryParams).toBeDefined();
    expect(tools[0].endpointMapping.queryParams!['q']).toBe('$q');
    expect(tools[0].endpointMapping.queryParams!['limit']).toBe('$limit');
  });

  it('should handle query parameters with variables (marked required)', async () => {
    const collection = {
      ...minimalCollection,
      item: [
        {
          name: 'Search',
          request: {
            method: 'GET',
            url: {
              raw: 'https://api.example.com/search?q={{query}}',
              path: ['search'],
              query: [
                { key: 'q', value: '{{query}}' },
              ],
            },
          },
        },
      ],
    };
    const tools = await parser.parse(collection);
    expect(tools).toHaveLength(1);
    const params = tools[0].parameters as any;
    expect(params.required).toContain('q');
    expect(tools[0].endpointMapping.queryParams!['q']).toBe('$q');
  });

  it('should skip disabled query parameters', async () => {
    const collection = {
      ...minimalCollection,
      item: [
        {
          name: 'Search',
          request: {
            method: 'GET',
            url: {
              raw: 'https://api.example.com/search?q=test&debug=true',
              path: ['search'],
              query: [
                { key: 'q', value: 'test' },
                { key: 'debug', value: 'true', disabled: true },
              ],
            },
          },
        },
      ],
    };
    const tools = await parser.parse(collection);
    expect(tools).toHaveLength(1);
    expect(tools[0].endpointMapping.queryParams!['q']).toBe('$q');
    expect(tools[0].endpointMapping.queryParams?.['debug']).toBeUndefined();
  });

  // ── Path variables ──────────────────────────────────────────────────────

  it('should handle {{var}} path variables', async () => {
    const collection = {
      ...minimalCollection,
      item: [
        {
          name: 'Get User',
          request: {
            method: 'GET',
            url: { raw: 'https://api.example.com/users/{{user_id}}', path: ['users', '{{user_id}}'] },
          },
        },
      ],
    };
    const tools = await parser.parse(collection);
    expect(tools).toHaveLength(1);
    const params = tools[0].parameters as any;
    expect(params.properties.user_id).toBeDefined();
    expect(params.required).toContain('user_id');
    expect(tools[0].endpointMapping.path).toBe('/users/{user_id}');
  });

  it('should handle {var} path parameters', async () => {
    const collection = {
      ...minimalCollection,
      item: [
        {
          name: 'Get Order',
          request: {
            method: 'GET',
            url: { raw: 'https://api.example.com/orders/{order_id}', path: ['orders', '{order_id}'] },
          },
        },
      ],
    };
    const tools = await parser.parse(collection);
    expect(tools).toHaveLength(1);
    const params = tools[0].parameters as any;
    expect(params.properties.order_id).toBeDefined();
    expect(params.required).toContain('order_id');
  });

  // ── REST POST with body types ──────────────────────────────────────────

  it('should parse POST with JSON body', async () => {
    const collection = {
      ...minimalCollection,
      item: [
        {
          name: 'Create User',
          request: {
            method: 'POST',
            url: { raw: 'https://api.example.com/users', path: ['users'] },
            body: {
              mode: 'raw',
              raw: '{"name":"John","age":30}',
            },
          },
        },
      ],
    };
    const tools = await parser.parse(collection);
    expect(tools).toHaveLength(1);
    expect(tools[0].endpointMapping.bodyMapping).toBeDefined();
    expect(tools[0].endpointMapping.bodyMapping!['name']).toBe('$name');
    expect(tools[0].endpointMapping.bodyMapping!['age']).toBe('$age');
  });

  it('should parse POST with JSON body containing {{variables}}', async () => {
    const collection = {
      ...minimalCollection,
      item: [
        {
          name: 'Create User',
          request: {
            method: 'POST',
            url: { raw: 'https://api.example.com/users', path: ['users'] },
            body: {
              mode: 'raw',
              raw: '{"name":"{{user_name}}","email":"{{user_email}}","age":25}',
            },
          },
        },
      ],
    };
    const tools = await parser.parse(collection);
    expect(tools).toHaveLength(1);
    const params = tools[0].parameters as any;
    expect(params.required).toContain('user_name');
    expect(params.required).toContain('user_email');
    expect(params.properties.age).toBeDefined();
    expect(tools[0].endpointMapping.bodyMapping!['name']).toBe('$user_name');
    expect(tools[0].endpointMapping.bodyMapping!['email']).toBe('$user_email');
    expect(tools[0].endpointMapping.bodyMapping!['age']).toBe('$age');
  });

  it('should parse POST with URL-encoded body', async () => {
    const collection = {
      ...minimalCollection,
      item: [
        {
          name: 'Login',
          request: {
            method: 'POST',
            url: { raw: 'https://api.example.com/auth/login', path: ['auth', 'login'] },
            body: {
              mode: 'urlencoded',
              urlencoded: [
                { key: 'username', value: '{{username}}', description: 'User login' },
                { key: 'password', value: '{{password}}', description: 'User password' },
              ],
            },
          },
        },
      ],
    };
    const tools = await parser.parse(collection);
    expect(tools).toHaveLength(1);
    expect(tools[0].endpointMapping.bodyMapping!['username']).toBe('$username');
    expect(tools[0].endpointMapping.bodyMapping!['password']).toBe('$password');
    const params = tools[0].parameters as any;
    expect(params.required).toContain('username');
    expect(params.required).toContain('password');
  });

  it('should parse POST with form-data body', async () => {
    const collection = {
      ...minimalCollection,
      item: [
        {
          name: 'Upload File',
          request: {
            method: 'POST',
            url: { raw: 'https://api.example.com/upload', path: ['upload'] },
            body: {
              mode: 'formdata',
              formdata: [
                { key: 'file', type: 'file', description: 'File to upload' },
                { key: 'description', value: 'test', type: 'text' },
              ],
            },
          },
        },
      ],
    };
    const tools = await parser.parse(collection);
    expect(tools).toHaveLength(1);
    expect(tools[0].endpointMapping.bodyMapping!['file']).toBe('$file');
    expect(tools[0].endpointMapping.bodyMapping!['description']).toBe('$description');
  });

  it('should skip disabled form-data fields', async () => {
    const collection = {
      ...minimalCollection,
      item: [
        {
          name: 'Upload',
          request: {
            method: 'POST',
            url: { raw: 'https://api.example.com/upload', path: ['upload'] },
            body: {
              mode: 'formdata',
              formdata: [
                { key: 'file', type: 'file' },
                { key: 'debug', type: 'text', disabled: true },
              ],
            },
          },
        },
      ],
    };
    const tools = await parser.parse(collection);
    expect(tools).toHaveLength(1);
    expect(tools[0].endpointMapping.bodyMapping!['file']).toBe('$file');
    expect(tools[0].endpointMapping.bodyMapping?.['debug']).toBeUndefined();
  });

  it('should handle raw non-JSON body (XML/SOAP)', async () => {
    const collection = {
      ...minimalCollection,
      item: [
        {
          name: 'SOAP Request',
          request: {
            method: 'POST',
            url: { raw: 'https://soap.example.com/ws', path: ['ws'] },
            body: {
              mode: 'raw',
              raw: '<?xml version="1.0"?><soap:Envelope><soap:Body><GetUser/></soap:Body></soap:Envelope>',
            },
          },
        },
      ],
    };
    const tools = await parser.parse(collection);
    expect(tools).toHaveLength(1);
    expect(tools[0].endpointMapping.bodyMapping!['__raw']).toBe('$body');
    const params = tools[0].parameters as any;
    expect(params.properties.body).toBeDefined();
    expect(params.required).toContain('body');
  });

  // ── Headers ─────────────────────────────────────────────────────────────

  it('should handle custom headers with variables', async () => {
    const collection = {
      ...minimalCollection,
      item: [
        {
          name: 'API Call',
          request: {
            method: 'GET',
            url: { raw: 'https://api.example.com/data', path: ['data'] },
            header: [
              { key: 'X-Custom-Token', value: '{{api_token}}' },
              { key: 'X-Version', value: '2024-01' },
            ],
          },
        },
      ],
    };
    const tools = await parser.parse(collection);
    expect(tools).toHaveLength(1);
    expect(tools[0].endpointMapping.headers!['X-Custom-Token']).toBe('$api_token');
    expect(tools[0].endpointMapping.headers!['X-Version']).toBe('2024-01');
    const params = tools[0].parameters as any;
    expect(params.properties.api_token).toBeDefined();
  });

  it('should skip standard headers (Content-Type, Authorization, Accept, User-Agent)', async () => {
    const collection = {
      ...minimalCollection,
      item: [
        {
          name: 'API Call',
          request: {
            method: 'GET',
            url: { raw: 'https://api.example.com/data', path: ['data'] },
            header: [
              { key: 'Content-Type', value: 'application/json' },
              { key: 'Authorization', value: 'Bearer {{token}}' },
              { key: 'Accept', value: 'application/json' },
              { key: 'User-Agent', value: 'Postman' },
              { key: 'X-Custom', value: 'keep-me' },
            ],
          },
        },
      ],
    };
    const tools = await parser.parse(collection);
    expect(tools).toHaveLength(1);
    expect(tools[0].endpointMapping.headers?.['Content-Type']).toBeUndefined();
    expect(tools[0].endpointMapping.headers?.['Authorization']).toBeUndefined();
    expect(tools[0].endpointMapping.headers?.['Accept']).toBeUndefined();
    expect(tools[0].endpointMapping.headers?.['User-Agent']).toBeUndefined();
    expect(tools[0].endpointMapping.headers!['X-Custom']).toBe('keep-me');
  });

  it('should skip disabled headers', async () => {
    const collection = {
      ...minimalCollection,
      item: [
        {
          name: 'API Call',
          request: {
            method: 'GET',
            url: { raw: 'https://api.example.com/data', path: ['data'] },
            header: [
              { key: 'X-Active', value: 'yes' },
              { key: 'X-Disabled', value: 'no', disabled: true },
            ],
          },
        },
      ],
    };
    const tools = await parser.parse(collection);
    expect(tools).toHaveLength(1);
    expect(tools[0].endpointMapping.headers!['X-Active']).toBe('yes');
    expect(tools[0].endpointMapping.headers?.['X-Disabled']).toBeUndefined();
  });

  // ── Folders & nesting ──────────────────────────────────────────────────

  it('should handle nested folders', async () => {
    const collection = {
      ...minimalCollection,
      item: [
        {
          name: 'Auth',
          item: [
            {
              name: 'Login',
              request: {
                method: 'POST',
                url: { raw: 'https://api.example.com/auth/login', path: ['auth', 'login'] },
              },
            },
          ],
        },
      ],
    };
    const tools = await parser.parse(collection);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('auth_login');
    expect(tools[0].description).toContain('Auth');
  });

  it('should handle deeply nested folders', async () => {
    const collection = {
      ...minimalCollection,
      item: [
        {
          name: 'API',
          item: [
            {
              name: 'V2',
              item: [
                {
                  name: 'Get Status',
                  request: {
                    method: 'GET',
                    url: { raw: 'https://api.example.com/v2/status', path: ['v2', 'status'] },
                  },
                },
              ],
            },
          ],
        },
      ],
    };
    const tools = await parser.parse(collection);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('v2_get_status');
  });

  it('should handle multiple requests across folders', async () => {
    const collection = {
      ...minimalCollection,
      item: [
        {
          name: 'Users',
          item: [
            {
              name: 'List Users',
              request: {
                method: 'GET',
                url: { raw: 'https://api.example.com/users', path: ['users'] },
              },
            },
            {
              name: 'Create User',
              request: {
                method: 'POST',
                url: { raw: 'https://api.example.com/users', path: ['users'] },
              },
            },
          ],
        },
        {
          name: 'Health',
          request: {
            method: 'GET',
            url: { raw: 'https://api.example.com/health', path: ['health'] },
          },
        },
      ],
    };
    const tools = await parser.parse(collection);
    expect(tools).toHaveLength(3);
  });

  // ── PUT / PATCH / DELETE ──────────────────────────────────────────────

  it('should handle PUT request with body', async () => {
    const collection = {
      ...minimalCollection,
      item: [
        {
          name: 'Update User',
          request: {
            method: 'PUT',
            url: { raw: 'https://api.example.com/users/{{id}}', path: ['users', '{{id}}'] },
            body: {
              mode: 'raw',
              raw: '{"name":"{{name}}","status":"active"}',
            },
          },
        },
      ],
    };
    const tools = await parser.parse(collection);
    expect(tools).toHaveLength(1);
    expect(tools[0].endpointMapping.method).toBe('PUT');
    expect(tools[0].endpointMapping.path).toBe('/users/{id}');
    expect(tools[0].endpointMapping.bodyMapping!['name']).toBe('$name');
    expect(tools[0].endpointMapping.bodyMapping!['status']).toBe('$status');
  });

  it('should handle DELETE request', async () => {
    const collection = {
      ...minimalCollection,
      item: [
        {
          name: 'Delete User',
          request: {
            method: 'DELETE',
            url: { raw: 'https://api.example.com/users/{{id}}', path: ['users', '{{id}}'] },
          },
        },
      ],
    };
    const tools = await parser.parse(collection);
    expect(tools).toHaveLength(1);
    expect(tools[0].endpointMapping.method).toBe('DELETE');
    expect(tools[0].endpointMapping.path).toBe('/users/{id}');
  });

  // ── URL as string ──────────────────────────────────────────────────────

  it('should handle URL as plain string instead of object', async () => {
    const collection = {
      ...minimalCollection,
      item: [
        {
          name: 'Simple',
          request: {
            method: 'GET',
            url: 'https://api.example.com/simple',
          },
        },
      ],
    };
    const tools = await parser.parse(collection);
    expect(tools).toHaveLength(1);
    expect(tools[0].endpointMapping.path).toBe('/simple');
  });

  // ── Description ────────────────────────────────────────────────────────

  it('should include request description in tool description', async () => {
    const collection = {
      ...minimalCollection,
      item: [
        {
          name: 'Get Users',
          request: {
            method: 'GET',
            url: { raw: 'https://api.example.com/users', path: ['users'] },
            description: 'Returns a list of all users in the system',
          },
        },
      ],
    };
    const tools = await parser.parse(collection);
    expect(tools).toHaveLength(1);
    expect(tools[0].description).toContain('Returns a list of all users');
  });

  // ── Collection variables ───────────────────────────────────────────────

  it('should not create params for collection-level variables', async () => {
    const collection = {
      ...minimalCollection,
      variable: [
        { key: 'base_url', value: 'https://api.example.com' },
      ],
      item: [
        {
          name: 'Get Data',
          request: {
            method: 'GET',
            url: { raw: '{{base_url}}/data', path: ['{{base_url}}', 'data'] },
          },
        },
      ],
    };
    const tools = await parser.parse(collection);
    expect(tools).toHaveLength(1);
    const params = tools[0].parameters as any;
    // base_url is a collection variable, should not become a required param
    expect(params.required?.includes('base_url')).toBeFalsy();
  });
});

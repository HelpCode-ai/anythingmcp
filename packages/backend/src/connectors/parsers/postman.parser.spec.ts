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

  it('should parse an empty collection', async () => {
    const tools = await parser.parse(minimalCollection);
    expect(tools).toHaveLength(0);
  });

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

  it('should parse from JSON string', async () => {
    const tools = await parser.parse(JSON.stringify(minimalCollection));
    expect(tools).toHaveLength(0);
  });
});

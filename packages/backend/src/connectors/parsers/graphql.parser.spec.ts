import { GraphqlParser } from './graphql.parser';
import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const makeIntrospectionResponse = (types: any[]) => ({
  data: {
    data: {
      __schema: {
        queryType: { name: 'Query' },
        mutationType: { name: 'Mutation' },
        types,
      },
    },
  },
});

const scalarType = (name: string) => ({ kind: 'SCALAR', name, ofType: null });
const nonNullType = (inner: any) => ({ kind: 'NON_NULL', name: null, ofType: inner });
const listType = (inner: any) => ({ kind: 'LIST', name: null, ofType: inner });

describe('GraphqlParser', () => {
  let parser: GraphqlParser;

  beforeEach(() => {
    parser = new GraphqlParser();
    jest.clearAllMocks();
  });

  describe('parse', () => {
    it('should make introspection query to the endpoint', async () => {
      mockedAxios.post.mockResolvedValue(makeIntrospectionResponse([]));
      await parser.parse('https://api.example.com/graphql');
      expect(mockedAxios.post).toHaveBeenCalledWith(
        'https://api.example.com/graphql',
        expect.objectContaining({ query: expect.stringContaining('IntrospectionQuery') }),
        expect.objectContaining({ timeout: 15000 }),
      );
    });

    it('should pass custom headers to the introspection request', async () => {
      mockedAxios.post.mockResolvedValue(makeIntrospectionResponse([]));
      await parser.parse('https://api.example.com/graphql', { Authorization: 'Bearer tok' });
      expect(mockedAxios.post).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Object),
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer tok' }),
        }),
      );
    });

    it('should extract query fields as tools', async () => {
      const types = [
        {
          kind: 'OBJECT',
          name: 'Query',
          fields: [
            { name: 'users', description: 'Get users', args: [] },
          ],
        },
      ];
      mockedAxios.post.mockResolvedValue(makeIntrospectionResponse(types));
      const tools = await parser.parse('https://api.example.com/graphql');
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('graphql_users');
      expect(tools[0].endpointMapping.method).toBe('query');
      expect(tools[0].endpointMapping.path).toBe('query { users }');
    });

    it('should extract mutation fields as tools', async () => {
      const types = [
        {
          kind: 'OBJECT',
          name: 'Mutation',
          fields: [
            { name: 'createUser', description: 'Create a user', args: [] },
          ],
        },
      ];
      mockedAxios.post.mockResolvedValue(makeIntrospectionResponse(types));
      const tools = await parser.parse('https://api.example.com/graphql');
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('graphql_createuser');
      expect(tools[0].endpointMapping.method).toBe('mutation');
    });

    it('should skip internal __-prefixed type fields', async () => {
      const types = [
        {
          kind: 'OBJECT',
          name: 'Query',
          fields: [
            { name: '__type', description: 'Internal', args: [] },
            { name: 'users', description: 'Get users', args: [] },
          ],
        },
      ];
      mockedAxios.post.mockResolvedValue(makeIntrospectionResponse(types));
      const tools = await parser.parse('https://api.example.com/graphql');
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('graphql_users');
    });

    it('should skip non-OBJECT types', async () => {
      const types = [
        { kind: 'SCALAR', name: 'String', fields: null },
        { kind: 'OBJECT', name: 'Query', fields: [{ name: 'ok', description: '', args: [] }] },
      ];
      mockedAxios.post.mockResolvedValue(makeIntrospectionResponse(types));
      const tools = await parser.parse('https://api.example.com/graphql');
      expect(tools).toHaveLength(1);
    });

    it('should map field args to tool parameters', async () => {
      const types = [
        {
          kind: 'OBJECT',
          name: 'Query',
          fields: [
            {
              name: 'user',
              description: 'Get user by id',
              args: [
                { name: 'id', description: 'User ID', type: scalarType('ID') },
                { name: 'limit', description: null, type: scalarType('Int') },
              ],
            },
          ],
        },
      ];
      mockedAxios.post.mockResolvedValue(makeIntrospectionResponse(types));
      const tools = await parser.parse('https://api.example.com/graphql');
      const params = tools[0].parameters as any;
      expect(params.properties.id).toEqual({ type: 'string', description: 'User ID' });
      expect(params.properties.limit).toEqual({ type: 'number' });
    });

    it('should mark NON_NULL args as required', async () => {
      const types = [
        {
          kind: 'OBJECT',
          name: 'Query',
          fields: [
            {
              name: 'user',
              description: '',
              args: [
                { name: 'id', description: '', type: nonNullType(scalarType('ID')) },
                { name: 'name', description: '', type: scalarType('String') },
              ],
            },
          ],
        },
      ];
      mockedAxios.post.mockResolvedValue(makeIntrospectionResponse(types));
      const tools = await parser.parse('https://api.example.com/graphql');
      const params = tools[0].parameters as any;
      expect(params.required).toEqual(['id']);
    });

    it('should map GraphQL types to JSON types correctly', async () => {
      const types = [
        {
          kind: 'OBJECT',
          name: 'Query',
          fields: [
            {
              name: 'test',
              description: '',
              args: [
                { name: 'count', description: '', type: scalarType('Int') },
                { name: 'price', description: '', type: scalarType('Float') },
                { name: 'active', description: '', type: scalarType('Boolean') },
                { name: 'label', description: '', type: scalarType('String') },
                { name: 'uid', description: '', type: scalarType('ID') },
              ],
            },
          ],
        },
      ];
      mockedAxios.post.mockResolvedValue(makeIntrospectionResponse(types));
      const tools = await parser.parse('https://api.example.com/graphql');
      const props = (tools[0].parameters as any).properties;
      expect(props.count.type).toBe('number');
      expect(props.price.type).toBe('number');
      expect(props.active.type).toBe('boolean');
      expect(props.label.type).toBe('string');
      expect(props.uid.type).toBe('string');
    });

    it('should build query string with args', async () => {
      const types = [
        {
          kind: 'OBJECT',
          name: 'Query',
          fields: [
            {
              name: 'user',
              description: '',
              args: [
                { name: 'id', description: '', type: nonNullType(scalarType('ID')) },
              ],
            },
          ],
        },
      ];
      mockedAxios.post.mockResolvedValue(makeIntrospectionResponse(types));
      const tools = await parser.parse('https://api.example.com/graphql');
      expect(tools[0].endpointMapping.path).toBe('query user($id: ID!) { user(id: $id) }');
    });

    it('should set variable mapping in queryParams', async () => {
      const types = [
        {
          kind: 'OBJECT',
          name: 'Query',
          fields: [
            {
              name: 'user',
              description: '',
              args: [
                { name: 'id', description: '', type: scalarType('ID') },
              ],
            },
          ],
        },
      ];
      mockedAxios.post.mockResolvedValue(makeIntrospectionResponse(types));
      const tools = await parser.parse('https://api.example.com/graphql');
      expect(tools[0].endpointMapping.queryParams).toEqual({ id: '$id' });
    });

    it('should throw on introspection errors', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { errors: [{ message: 'Unauthorized' }] },
      });
      await expect(
        parser.parse('https://api.example.com/graphql'),
      ).rejects.toThrow('GraphQL introspection errors');
    });

    it('should handle LIST type in type string', async () => {
      const types = [
        {
          kind: 'OBJECT',
          name: 'Query',
          fields: [
            {
              name: 'items',
              description: '',
              args: [
                { name: 'ids', description: '', type: listType(scalarType('ID')) },
              ],
            },
          ],
        },
      ];
      mockedAxios.post.mockResolvedValue(makeIntrospectionResponse(types));
      const tools = await parser.parse('https://api.example.com/graphql');
      expect(tools[0].endpointMapping.path).toContain('[ID]');
    });
  });
});

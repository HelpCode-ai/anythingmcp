import { CurlParser } from './curl.parser';

describe('CurlParser', () => {
  let parser: CurlParser;

  beforeEach(() => {
    parser = new CurlParser();
  });

  // ── REST GET ─────────────────────────────────────────────────────────────

  it('should parse a simple GET cURL', () => {
    const tools = parser.parse('curl https://api.example.com/users');
    expect(tools).toHaveLength(1);
    expect(tools[0].endpointMapping.method).toBe('GET');
    expect(tools[0].endpointMapping.path).toBe('/users');
  });

  it('should parse GET with static query parameters', () => {
    const tools = parser.parse(
      `curl 'https://api.example.com/search?q=test&limit=10&offset=0'`,
    );
    expect(tools).toHaveLength(1);
    expect(tools[0].endpointMapping.method).toBe('GET');
    expect(tools[0].endpointMapping.path).toBe('/search');
    expect(tools[0].endpointMapping.queryParams).toBeDefined();
    const params = tools[0].parameters as any;
    expect(params.properties.q).toBeDefined();
    expect(params.properties.q.default).toBe('test');
    expect(params.properties.limit).toBeDefined();
    expect(params.properties.limit.default).toBe('10');
  });

  it('should parse GET with variable query parameters', () => {
    const tools = parser.parse(
      `curl 'https://api.example.com/search?q={{query}}&limit={{limit}}'`,
    );
    expect(tools).toHaveLength(1);
    const params = tools[0].parameters as any;
    expect(params.properties.query).toBeDefined();
    expect(params.properties.limit).toBeDefined();
    expect(params.required).toContain('query');
    expect(params.required).toContain('limit');
    expect(tools[0].endpointMapping.queryParams).toEqual({
      q: '$query',
      limit: '$limit',
    });
  });

  it('should parse GET with path variables', () => {
    const tools = parser.parse(
      `curl https://api.example.com/users/{{user_id}}/posts/{{post_id}}`,
    );
    expect(tools).toHaveLength(1);
    const params = tools[0].parameters as any;
    expect(params.properties.user_id).toBeDefined();
    expect(params.properties.post_id).toBeDefined();
    expect(params.required).toContain('user_id');
    expect(params.required).toContain('post_id');
    expect(tools[0].endpointMapping.path).toBe('/users/{user_id}/posts/{post_id}');
  });

  // ── REST POST with JSON body ─────────────────────────────────────────────

  it('should parse POST with JSON body', () => {
    const tools = parser.parse(
      `curl -X POST https://api.example.com/users -H 'Content-Type: application/json' -d '{"name":"John","email":"john@example.com"}'`,
    );
    expect(tools).toHaveLength(1);
    expect(tools[0].endpointMapping.method).toBe('POST');
    expect(tools[0].endpointMapping.bodyMapping).toBeDefined();
    expect(tools[0].endpointMapping.bodyMapping!['name']).toBe('$name');
    expect(tools[0].endpointMapping.bodyMapping!['email']).toBe('$email');
  });

  it('should parse POST with JSON body containing variables', () => {
    const tools = parser.parse(
      `curl -X POST https://api.example.com/users -H 'Content-Type: application/json' -d '{"name":"{{user_name}}","email":"{{user_email}}","age":25}'`,
    );
    expect(tools).toHaveLength(1);
    const params = tools[0].parameters as any;
    expect(params.required).toContain('user_name');
    expect(params.required).toContain('user_email');
    expect(params.properties.age).toBeDefined();
    expect(params.properties.age.default).toBe(25);
    expect(params.properties.age.type).toBe('number');
    expect(tools[0].endpointMapping.bodyMapping!['name']).toBe('$user_name');
    expect(tools[0].endpointMapping.bodyMapping!['email']).toBe('$user_email');
    expect(tools[0].endpointMapping.bodyMapping!['age']).toBe('$age');
  });

  it('should parse POST with nested JSON body', () => {
    const tools = parser.parse(
      `curl -X POST https://api.example.com/create -H 'Content-Type: application/json' -d '{"name":"test","config":{"enabled":true,"count":5}}'`,
    );
    expect(tools).toHaveLength(1);
    const params = tools[0].parameters as any;
    expect(params.properties.name).toBeDefined();
    expect(params.properties.config).toBeDefined();
  });

  it('should parse POST with -d flag auto-detecting method', () => {
    const tools = parser.parse(
      `curl https://api.example.com/data -d '{"key":"value"}'`,
    );
    expect(tools).toHaveLength(1);
    expect(tools[0].endpointMapping.method).toBe('POST');
  });

  it('should parse POST with --data-raw flag', () => {
    const tools = parser.parse(
      `curl -X POST https://api.example.com/data --data-raw '{"message":"hello"}'`,
    );
    expect(tools).toHaveLength(1);
    expect(tools[0].endpointMapping.method).toBe('POST');
    expect(tools[0].endpointMapping.bodyMapping!['message']).toBe('$message');
  });

  // ── REST with custom headers + auth ──────────────────────────────────────

  it('should parse headers with variables', () => {
    const tools = parser.parse(
      `curl https://api.example.com/data -H 'X-Custom: {{api_token}}'`,
    );
    expect(tools).toHaveLength(1);
    const params = tools[0].parameters as any;
    expect(params.properties.api_token).toBeDefined();
    expect(tools[0].endpointMapping.headers!['X-Custom']).toBe('$api_token');
  });

  it('should parse static custom headers', () => {
    const tools = parser.parse(
      `curl https://api.example.com/data -H 'X-Api-Version: 2024-01'`,
    );
    expect(tools).toHaveLength(1);
    expect(tools[0].endpointMapping.headers!['X-Api-Version']).toBe('2024-01');
  });

  it('should skip Content-Type, Accept, and User-Agent headers', () => {
    const tools = parser.parse(
      `curl https://api.example.com/data -H 'Content-Type: application/json' -H 'accept: text/html' -H 'user-agent: custom' -H 'X-Custom: foo'`,
    );
    expect(tools).toHaveLength(1);
    expect(tools[0].endpointMapping.headers?.['Content-Type']).toBeUndefined();
    expect(tools[0].endpointMapping.headers?.['accept']).toBeUndefined();
    expect(tools[0].endpointMapping.headers?.['user-agent']).toBeUndefined();
    expect(tools[0].endpointMapping.headers!['X-Custom']).toBe('foo');
  });

  it('should skip Authorization header in mapping', () => {
    const tools = parser.parse(
      `curl https://api.example.com/data -H 'Authorization: Bearer xxx' -H 'X-Custom: bar'`,
    );
    expect(tools).toHaveLength(1);
    expect(tools[0].endpointMapping.headers?.['Authorization']).toBeUndefined();
    expect(tools[0].endpointMapping.headers!['X-Custom']).toBe('bar');
  });

  it('should handle -u basic auth flag', () => {
    const tools = parser.parse(
      `curl -u admin:password123 https://api.example.com/secure`,
    );
    expect(tools).toHaveLength(1);
    expect(tools[0].endpointMapping.method).toBe('GET');
    expect(tools[0].endpointMapping.path).toBe('/secure');
  });

  // ── REST PUT / PATCH / DELETE ────────────────────────────────────────────

  it('should handle -X method flag (DELETE)', () => {
    const tools = parser.parse('curl -X DELETE https://api.example.com/users/123');
    expect(tools).toHaveLength(1);
    expect(tools[0].endpointMapping.method).toBe('DELETE');
  });

  it('should parse PUT with JSON body and path variables', () => {
    const tools = parser.parse(
      `curl -X PUT https://api.example.com/users/{{id}} -H 'Content-Type: application/json' -d '{"name":"{{name}}","status":"active"}'`,
    );
    expect(tools).toHaveLength(1);
    expect(tools[0].endpointMapping.method).toBe('PUT');
    expect(tools[0].endpointMapping.path).toBe('/users/{id}');
    const params = tools[0].parameters as any;
    expect(params.properties.id).toBeDefined();
    expect(params.properties.name).toBeDefined();
    expect(params.required).toContain('id');
    expect(params.required).toContain('name');
    expect(tools[0].endpointMapping.bodyMapping!['name']).toBe('$name');
    expect(tools[0].endpointMapping.bodyMapping!['status']).toBe('$status');
  });

  it('should parse PATCH with partial update body', () => {
    const tools = parser.parse(
      `curl -X PATCH https://api.example.com/users/{{id}} -H 'Content-Type: application/json' -d '{"email":"{{email}}"}'`,
    );
    expect(tools).toHaveLength(1);
    expect(tools[0].endpointMapping.method).toBe('PATCH');
    expect(tools[0].endpointMapping.path).toBe('/users/{id}');
    expect(tools[0].endpointMapping.bodyMapping!['email']).toBe('$email');
  });

  // ── SOAP / Raw XML body ──────────────────────────────────────────────────

  it('should parse POST with raw XML/SOAP body', () => {
    const tools = parser.parse(
      `curl -X POST https://soap.example.com/ws -H 'Content-Type: text/xml' -d '<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><GetUser><UserId>123</UserId></GetUser></soap:Body></soap:Envelope>'`,
    );
    expect(tools).toHaveLength(1);
    expect(tools[0].endpointMapping.method).toBe('POST');
    expect(tools[0].endpointMapping.bodyMapping!['__raw']).toBe('$body');
    const params = tools[0].parameters as any;
    expect(params.properties.body).toBeDefined();
    expect(params.properties.body.type).toBe('string');
  });

  it('should parse POST with raw body containing variables', () => {
    const tools = parser.parse(
      `curl -X POST https://soap.example.com/ws -H 'Content-Type: text/xml' -d '{{soap_body}}'`,
    );
    expect(tools).toHaveLength(1);
    expect(tools[0].endpointMapping.bodyMapping!['__raw']).toBe('$soap_body');
    const params = tools[0].parameters as any;
    expect(params.properties.soap_body).toBeDefined();
    expect(params.required).toContain('soap_body');
  });

  // ── GraphQL POST ─────────────────────────────────────────────────────────

  it('should parse GraphQL POST with query in JSON body', () => {
    const tools = parser.parse(
      `curl -X POST https://api.example.com/graphql -H 'Content-Type: application/json' -d '{"query":"query { users { id name } }","variables":{}}'`,
    );
    expect(tools).toHaveLength(1);
    expect(tools[0].endpointMapping.method).toBe('POST');
    const params = tools[0].parameters as any;
    expect(params.properties.query).toBeDefined();
    expect(params.properties.query.default).toBe('query { users { id name } }');
  });

  // ── Multiple commands ────────────────────────────────────────────────────

  it('should parse multiple cURL commands', () => {
    const input = `curl https://api.example.com/users
curl -X POST https://api.example.com/users -d '{}'`;
    const tools = parser.parse(input);
    expect(tools).toHaveLength(2);
  });

  it('should parse three different methods', () => {
    const input = `curl https://api.example.com/users
curl -X POST https://api.example.com/users -d '{"name":"test"}'
curl -X DELETE https://api.example.com/users/1`;
    const tools = parser.parse(input);
    expect(tools).toHaveLength(3);
    expect(tools[0].endpointMapping.method).toBe('GET');
    expect(tools[1].endpointMapping.method).toBe('POST');
    expect(tools[2].endpointMapping.method).toBe('DELETE');
  });

  // ── Multiline / continuation ─────────────────────────────────────────────

  it('should handle multiline cURL with backslash continuation', () => {
    const tools = parser.parse(
      `curl -X POST \\
  https://api.example.com/users \\
  -H 'Content-Type: application/json' \\
  -d '{"name":"test"}'`,
    );
    expect(tools).toHaveLength(1);
    expect(tools[0].endpointMapping.method).toBe('POST');
  });

  it('should handle complex multiline with headers and body', () => {
    const tools = parser.parse(
      `curl -X POST \\
  'https://api.example.com/v2/orders' \\
  -H 'Content-Type: application/json' \\
  -H 'X-Request-Id: {{request_id}}' \\
  -d '{
    "product_id": "{{product_id}}",
    "quantity": 1
  }'`,
    );
    expect(tools).toHaveLength(1);
    expect(tools[0].endpointMapping.method).toBe('POST');
    expect(tools[0].endpointMapping.path).toBe('/v2/orders');
    const params = tools[0].parameters as any;
    expect(params.properties.request_id).toBeDefined();
    expect(params.properties.product_id).toBeDefined();
    expect(tools[0].endpointMapping.headers!['X-Request-Id']).toBe('$request_id');
    expect(tools[0].endpointMapping.bodyMapping!['product_id']).toBe('$product_id');
  });

  // ── Edge cases ───────────────────────────────────────────────────────────

  it('should generate meaningful tool names', () => {
    const tools = parser.parse('curl -X GET https://api.example.com/v1/users/list');
    expect(tools[0].name).toMatch(/get_v1_users_list/);
  });

  it('should handle URL without path', () => {
    const tools = parser.parse('curl https://api.example.com');
    expect(tools).toHaveLength(1);
    expect(tools[0].endpointMapping.path).toBe('/');
  });

  it('should skip curl without URL', () => {
    const tools = parser.parse('curl -H "Accept: application/json"');
    expect(tools).toHaveLength(0);
  });

  it('should handle --data-urlencode flag', () => {
    const tools = parser.parse(
      `curl https://api.example.com/search --data-urlencode 'q=hello world'`,
    );
    expect(tools).toHaveLength(1);
    expect(tools[0].endpointMapping.method).toBe('POST');
  });

  it('should handle --data-binary flag', () => {
    const tools = parser.parse(
      `curl -X POST https://api.example.com/upload --data-binary '{{file_data}}'`,
    );
    expect(tools).toHaveLength(1);
    expect(tools[0].endpointMapping.method).toBe('POST');
    expect(tools[0].endpointMapping.bodyMapping!['__raw']).toBe('$file_data');
  });

  it('should handle JSON body with boolean and null values', () => {
    const tools = parser.parse(
      `curl -X POST https://api.example.com/settings -H 'Content-Type: application/json' -d '{"enabled":true,"count":0,"label":null}'`,
    );
    expect(tools).toHaveLength(1);
    const params = tools[0].parameters as any;
    expect(params.properties.enabled).toBeDefined();
    expect(params.properties.enabled.type).toBe('boolean');
    expect(params.properties.enabled.default).toBe(true);
    expect(params.properties.count).toBeDefined();
    expect(params.properties.count.type).toBe('number');
    expect(params.properties.count.default).toBe(0);
  });

  it('should handle JSON body with array value', () => {
    const tools = parser.parse(
      `curl -X POST https://api.example.com/batch -d '{"ids":[1,2,3],"action":"delete"}'`,
    );
    expect(tools).toHaveLength(1);
    const params = tools[0].parameters as any;
    expect(params.properties.ids).toBeDefined();
    expect(params.properties.ids.type).toBe('array');
    expect(params.properties.action).toBeDefined();
  });

  it('should handle URL with port', () => {
    const tools = parser.parse('curl http://localhost:8080/api/health');
    expect(tools).toHaveLength(1);
    expect(tools[0].endpointMapping.path).toBe('/api/health');
  });

  it('should handle double-quoted strings in curl', () => {
    const tools = parser.parse(
      `curl -X POST https://api.example.com/data -H "Content-Type: application/json" -d "{\\"name\\":\\"test\\"}"`,
    );
    expect(tools).toHaveLength(1);
    expect(tools[0].endpointMapping.method).toBe('POST');
  });

  it('should handle mixed variables and static values in query params', () => {
    const tools = parser.parse(
      `curl 'https://api.example.com/search?q={{query}}&format=json&page={{page}}'`,
    );
    expect(tools).toHaveLength(1);
    const params = tools[0].parameters as any;
    expect(params.properties.query).toBeDefined();
    expect(params.required).toContain('query');
    expect(params.properties.format).toBeDefined();
    expect(params.properties.format.default).toBe('json');
    expect(params.properties.page).toBeDefined();
    expect(params.required).toContain('page');
  });

  it('should handle multiple headers', () => {
    const tools = parser.parse(
      `curl https://api.example.com/data -H 'X-Api-Key: {{api_key}}' -H 'X-Tenant: acme' -H 'X-Version: v2'`,
    );
    expect(tools).toHaveLength(1);
    expect(tools[0].endpointMapping.headers!['X-Api-Key']).toBe('$api_key');
    expect(tools[0].endpointMapping.headers!['X-Tenant']).toBe('acme');
    expect(tools[0].endpointMapping.headers!['X-Version']).toBe('v2');
    const params = tools[0].parameters as any;
    expect(params.properties.api_key).toBeDefined();
  });

  it('should handle --request (long form) flag', () => {
    const tools = parser.parse('curl --request PUT https://api.example.com/users/1');
    expect(tools).toHaveLength(1);
    expect(tools[0].endpointMapping.method).toBe('PUT');
  });

  it('should handle --header (long form) flag', () => {
    const tools = parser.parse(
      `curl https://api.example.com/data --header 'X-Custom: value'`,
    );
    expect(tools).toHaveLength(1);
    expect(tools[0].endpointMapping.headers!['X-Custom']).toBe('value');
  });

  it('should handle --data (long form) flag', () => {
    const tools = parser.parse(
      `curl -X POST https://api.example.com/data --data '{"key":"value"}'`,
    );
    expect(tools).toHaveLength(1);
    expect(tools[0].endpointMapping.bodyMapping!['key']).toBe('$key');
  });

  it('should handle empty JSON body', () => {
    const tools = parser.parse(
      `curl -X POST https://api.example.com/trigger -d '{}'`,
    );
    expect(tools).toHaveLength(1);
    expect(tools[0].endpointMapping.method).toBe('POST');
  });

  it('should handle deeply nested path', () => {
    const tools = parser.parse(
      `curl https://api.example.com/v2/organizations/{{org_id}}/projects/{{project_id}}/tasks`,
    );
    expect(tools).toHaveLength(1);
    expect(tools[0].endpointMapping.path).toBe('/v2/organizations/{org_id}/projects/{project_id}/tasks');
    const params = tools[0].parameters as any;
    expect(params.required).toContain('org_id');
    expect(params.required).toContain('project_id');
  });
});

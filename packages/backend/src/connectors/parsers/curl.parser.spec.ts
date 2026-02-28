import { CurlParser } from './curl.parser';

describe('CurlParser', () => {
  let parser: CurlParser;

  beforeEach(() => {
    parser = new CurlParser();
  });

  it('should parse a simple GET cURL', () => {
    const tools = parser.parse('curl https://api.example.com/users');
    expect(tools).toHaveLength(1);
    expect(tools[0].endpointMapping.method).toBe('GET');
    expect(tools[0].endpointMapping.path).toBe('/users');
  });

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

  it('should parse headers with variables', () => {
    const tools = parser.parse(
      `curl https://api.example.com/data -H 'X-Custom: {{api_token}}'`,
    );
    expect(tools).toHaveLength(1);
    const params = tools[0].parameters as any;
    expect(params.properties.api_token).toBeDefined();
  });

  it('should handle -X method flag', () => {
    const tools = parser.parse('curl -X DELETE https://api.example.com/users/123');
    expect(tools).toHaveLength(1);
    expect(tools[0].endpointMapping.method).toBe('DELETE');
  });

  it('should parse multiple cURL commands', () => {
    const input = `curl https://api.example.com/users
curl -X POST https://api.example.com/users -d '{}'`;
    const tools = parser.parse(input);
    expect(tools).toHaveLength(2);
  });

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
});

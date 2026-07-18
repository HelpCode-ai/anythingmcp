import {
  interpolateString,
  interpolateDeep,
  interpolateConnectorConfig,
} from './env-interpolation.util';

describe('EnvInterpolation', () => {
  const envVars = {
    API_BASE: 'https://api.example.com',
    API_VERSION: 'v2',
    TOKEN: 'secret-token-123',
  };

  describe('interpolateString', () => {
    it('should replace {{VAR}} patterns', () => {
      expect(interpolateString('{{API_BASE}}/{{API_VERSION}}/users', envVars))
        .toBe('https://api.example.com/v2/users');
    });

    it('should leave unknown variables unchanged', () => {
      expect(interpolateString('{{UNKNOWN}}/test', envVars))
        .toBe('{{UNKNOWN}}/test');
    });

    it('should handle strings without variables', () => {
      expect(interpolateString('no vars here', envVars))
        .toBe('no vars here');
    });

    it('should handle empty envVars', () => {
      expect(interpolateString('{{API_BASE}}', {}))
        .toBe('{{API_BASE}}');
    });

    it('should return a non-string template unchanged (no throw)', () => {
      // Static tools omit `path`; interpolating undefined must not crash.
      expect(interpolateString(undefined as unknown as string, envVars))
        .toBeUndefined();
    });
  });

  describe('interpolateDeep', () => {
    it('should interpolate nested objects', () => {
      const input = {
        url: '{{API_BASE}}/users',
        headers: { Authorization: 'Bearer {{TOKEN}}' },
      };
      const result = interpolateDeep(input, envVars);
      expect(result.url).toBe('https://api.example.com/users');
      expect(result.headers.Authorization).toBe('Bearer secret-token-123');
    });

    it('should interpolate arrays', () => {
      const input = ['{{API_BASE}}', '{{API_VERSION}}'];
      const result = interpolateDeep(input, envVars);
      expect(result).toEqual(['https://api.example.com', 'v2']);
    });

    it('should not mutate original', () => {
      const input = { url: '{{API_BASE}}' };
      interpolateDeep(input, envVars);
      expect(input.url).toBe('{{API_BASE}}');
    });

    it('should handle non-string values', () => {
      const input = { count: 42, active: true, data: null };
      const result = interpolateDeep(input, envVars);
      expect(result).toEqual({ count: 42, active: true, data: null });
    });
  });

  describe('interpolateConnectorConfig', () => {
    it('should interpolate baseUrl and endpoint mapping', () => {
      const config = { baseUrl: '{{API_BASE}}', headers: { 'X-Token': '{{TOKEN}}' } };
      const mapping = {
        method: 'GET',
        path: '/{{API_VERSION}}/users',
        queryParams: { token: '{{TOKEN}}' },
      };
      const result = interpolateConnectorConfig(config, mapping, envVars);
      expect(result.config.baseUrl).toBe('https://api.example.com');
      expect(result.config.headers!['X-Token']).toBe('secret-token-123');
      expect(result.endpointMapping.path).toBe('/v2/users');
    });

    it('should pass through when envVars is empty', () => {
      const config = { baseUrl: '{{API_BASE}}' };
      const mapping = { method: 'GET', path: '/users' };
      const result = interpolateConnectorConfig(config, mapping, {});
      expect(result.config.baseUrl).toBe('{{API_BASE}}');
    });

    it('should not throw for a static tool with no path', () => {
      // Regression: a `static` tool endpointMapping has no `path`; with a
      // connector that HAS env vars, interpolation used to crash on
      // interpolateString(undefined).
      const config = { baseUrl: 'https://v3.football.api-sports.io' };
      const mapping = {
        method: 'static',
        staticResponse: 'PLAYBOOK …',
      } as unknown as { method: string; path: string };
      const result = interpolateConnectorConfig(config, mapping, envVars);
      expect(result.endpointMapping.path).toBeUndefined();
      expect(result.config.baseUrl).toBe('https://v3.football.api-sports.io');
    });
  });
});

import * as adapter from './loom.json';
import { resolveMcpEndpointUrl } from '../../common/url.util';
import { localMcpToolName } from '../../connectors/mcp-connector-config.util';
import { mergeDiscoveredMcpTools } from '../mcp-adapter.util';

// Static checks only: no public Loom test server or credentials are supplied.
describe('loom adapter: static MCP bridge conformance', () => {
  it('keeps the complete endpoint separate from the bearer token', () => {
    expect(adapter.connector.type).toBe('MCP');
    expect(adapter.connector.baseUrl).toBe('{{LOOM_MCP_URL}}');
    expect(adapter.connector.authType).toBe('BEARER_TOKEN');
    expect(adapter.connector.authConfig).toEqual({ token: '{{LOOM_MCP_TOKEN}}' });
    expect(adapter.requiredEnvVars).toEqual(['LOOM_MCP_URL', 'LOOM_MCP_TOKEN']);
    expect(adapter.envVarMeta.LOOM_MCP_TOKEN.secret).toBe(true);
    expect(JSON.stringify(adapter.connector.config)).not.toContain('LOOM_MCP_TOKEN');
    expect(JSON.stringify(adapter.tools)).not.toContain('LOOM_MCP_TOKEN');
    expect('probe' in adapter).toBe(false);
  });

  it('accepts HTTPS proxy paths and listing options without URL credentials', () => {
    const pattern = new RegExp(adapter.envVarMeta.LOOM_MCP_URL.pattern);
    for (const url of [
      'https://memory.example.net/mcp',
      'https://gateway.example.net/agents/loom/mcp',
      'https://memory.example.net:8443/mcp?toolset=readonly',
      'https://memory.example.net/mcp?toolset=coding+tracker&schema_profile=compact',
    ]) {
      expect(pattern.test(url)).toBe(true);
      expect(resolveMcpEndpointUrl(url, '/mcp').toString()).toBe(url);
    }
    for (const url of [
      'http://memory.example.net/mcp',
      'memory.example.net/mcp',
      'https://memory.example.net',
      'https://user:password@memory.example.net/mcp',
      'https://memory.example.net/mcp?token=credential',
      'https://memory.example.net/mcp?toolset=core&token=credential',
      'https://memory.example.net/mcp#credential',
    ]) expect(pattern.test(url)).toBe(false);
  });

  it('keeps only the documented read-only primer in the fallback snapshot', () => {
    expect(adapter.tools).toHaveLength(1);
    const tool = adapter.tools[0];
    expect(tool.name).toBe('loom_activate');
    expect(tool.endpointMapping).toEqual({ method: 'loom_activate', path: '/mcp' });
    expect(tool.parameters).toEqual({ type: 'object', properties: {}, additionalProperties: false });
    expect(tool.annotations.readOnlyHint).toBe(true);
    expect(localMcpToolName(tool.endpointMapping.method, adapter.connector.config.mcpToolPrefix)).toBe(tool.name);
  });

  it('uses the connected server schemas and leaves native Loom names intact', () => {
    // A deployment can expose a different roster, including the assistant toolset.
    const remote = {
      name: 'loom_memory_get',
      description: 'Read a memory using the schema published by this deployment.',
      parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
      endpointMapping: { method: 'loom_memory_get', path: '/mcp' },
    };
    const discovered = [{ ...remote, outputSchema: null, annotations: null }];
    const installed = mergeDiscoveredMcpTools(adapter.tools, discovered, adapter.connector.config.mcpToolPrefix);
    expect(installed).toEqual([remote]);
    expect(installed.some((tool) => tool.name === 'loom_activate')).toBe(false);
  });
});

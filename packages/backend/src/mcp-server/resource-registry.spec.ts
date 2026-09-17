import {
  contentFromFetchConfig,
  makeResource,
  registerResources,
} from './resource-registry';
import type { McpServer } from '@modelcontextprotocol/server';

describe('resource-registry', () => {
  it('does not expose arbitrary data stored beside fetch metadata', () => {
    expect(contentFromFetchConfig({
      data: { apiKey: 'must-not-reach-model-context' },
      url: 'https://example.test',
      mimeType: 'application/json',
    })).toEqual({
      text: '[resource content is not available: only local static content is supported]',
    });
  });

  it('preserves explicitly authored static text and content', () => {
    expect(contentFromFetchConfig({ text: 'setup notes', mimeType: 'text/markdown' })).toEqual({
      text: 'setup notes',
      mimeType: 'text/markdown',
    });
    expect(contentFromFetchConfig({ content: 'reference card' })).toEqual({
      text: 'reference card',
      mimeType: undefined,
    });
  });

  it('fails closed for unsupported remote fetch configurations', async () => {
    const resource = makeResource({
      uri: 'https://example.test/private',
      name: 'remote',
      fetchConfig: { type: 'url', url: 'https://169.254.169.254/' },
    });
    await expect(resource.read()).resolves.toEqual({
      text: '[resource content is not available: only local static content is supported]',
      mimeType: 'text/plain',
    });
  });

  it('registers each URI once and returns requested URI metadata', async () => {
    const registrations: any[] = [];
    const server = {
      registerResource: (...args: any[]) => {
        registrations.push(args);
        return { remove: jest.fn() };
      },
    };
    const warn = jest.fn();
    const resource = makeResource(
      { uri: 'anythingmcp://x', name: 'x', fetchConfig: {} },
      { text: 'hello', mimeType: 'text/plain' },
    );
    expect(registerResources(server as unknown as McpServer, [resource, resource], warn)).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Duplicate MCP resource URI'));
    const callback = registrations[0][3];
    await expect(callback({ href: 'anythingmcp://x' })).resolves.toEqual({
      contents: [{ uri: 'anythingmcp://x', mimeType: 'text/plain', text: 'hello' }],
    });
  });
});

import { McpStrategy, StreamableHttpTransport } from '@rekog/mcp-nest';

/**
 * The MCP server, as a NestJS microservice transport strategy.
 *
 * mcp-nest v2 has no `McpModule`: the strategy IS the server and the registry.
 * It lives in its own file rather than in `app.module` so that
 * `McpEndpointController` can reach the transport's HTTP handlers without
 * importing `app.module` and creating a cycle.
 */

/**
 * `mount: false` is the load-bearing option here.
 *
 * Left to mount itself, the transport would register `/mcp` directly on the
 * HTTP adapter, outside Nest's controller pipeline — and v2 dropped the
 * `guards` option that used to protect it, so the endpoint would come up
 * UNAUTHENTICATED. Claiming the handlers instead lets `McpEndpointController`
 * serve them behind `McpCombinedAuthGuard`, the same guard that already
 * protects every per-tenant `/mcp/:serverId`.
 */
export const mcpHttpTransport = new StreamableHttpTransport({
  endpoint: '/mcp',
  enableJsonResponse: true,
  mount: false,
  // 'dual' serves BOTH the stateless 2026-07-28 protocol and the older
  // handshake-based revisions from the same endpoint. Every client connected
  // today speaks one of the latter, so anything narrower would cut every
  // existing tenant off the moment this deploys.
  protocol: 'dual',
});

export const mcpStrategy = new McpStrategy({
  name: 'anythingmcp',
  version: '0.1.0',
  transports: [mcpHttpTransport],
});

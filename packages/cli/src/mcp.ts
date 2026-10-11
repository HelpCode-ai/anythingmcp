import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Profile } from './config.js';

export function serverUrl(profile: Pick<Profile, 'url' | 'server'>): URL {
  const base = new URL(profile.url);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password ||
      base.search || base.hash) throw new Error('Invalid server URL');
  if (!/^[a-zA-Z0-9_-]+$/.test(profile.server)) throw new Error('Invalid server ID');
  if (base.pathname.endsWith('/mcp') || /\/mcp\//.test(base.pathname)) {
    throw new Error('Pass the instance base URL, without /mcp');
  }
  base.pathname = `${base.pathname.replace(/\/$/, '')}/mcp/${profile.server}`;
  return base;
}

export async function withClient<T>(profile: Profile, action: (client: Client) => Promise<T>): Promise<T> {
  const transport = new StreamableHTTPClientTransport(serverUrl(profile), {
    requestInit: { headers: { 'X-API-Key': profile.key } },
  });
  const client = new Client({ name: 'amcp-cli', version: '0.1.0' });
  try {
    await client.connect(transport);
    return await action(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function listTools(profile: Profile) {
  return withClient(profile, async (client) => {
    const tools: Awaited<ReturnType<Client['listTools']>>['tools'] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const result = await client.listTools(cursor ? { cursor } : undefined);
      tools.push(...result.tools);
      if (!result.nextCursor) return tools;
      cursor = result.nextCursor;
    }
    throw new Error('Tool list exceeded 50 pages');
  });
}

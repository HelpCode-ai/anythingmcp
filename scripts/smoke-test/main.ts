/* eslint-disable no-console */
/**
 * AnythingMCP smoke test
 * ----------------------
 * End-to-end check that exercises every connector type we ship and verifies
 * the per-server MCP endpoint actually returns useful data over the MCP
 * protocol after the Sprint 1 hardening (prepared statements, SSRF guard,
 * tightened CORS, body-template sanitisation, secret enforcement, IDOR fixes).
 *
 * Flow:
 *   1. Wait for /health on the running stack.
 *   2. Register an admin (open registration is on for the smoke profile).
 *   3. List MCP servers — the default one is created on register.
 *   4. Create connectors:
 *        - REST   → https://jsonplaceholder.typicode.com
 *        - SOAP   → http://www.dataaccess.com/.../NumberConversion.wso
 *        - GRAPHQL→ https://countries.trevorblades.com/
 *        - DATABASE/MySQL → in-stack mysql container with sample data
 *   5. Define one or two tools per connector (manual definitions to avoid
 *      depending on remote SDL/Swagger fetchers, which we already SSRF-guard).
 *   6. Assign all four connectors to the default MCP server.
 *   7. Mint an MCP API key bound to that server.
 *   8. Connect via @modelcontextprotocol/sdk to /mcp/<serverId> using the key.
 *   9. List tools, then invoke one tool per connector and assert the response
 *      contains the expected substring.
 *  10. Print a summary; exit non-zero on any failure.
 */

import axios, { AxiosInstance } from 'axios';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const API_BASE = process.env.SMOKE_API_BASE || 'http://localhost:4000';
const ADMIN_EMAIL =
  process.env.SMOKE_ADMIN_EMAIL || `smoke-${Date.now()}@anythingmcp.local`;
const ADMIN_PASSWORD = process.env.SMOKE_ADMIN_PASSWORD || 'Smoke!Pass#2026';
const ADMIN_NAME = 'Smoke Tester';

interface CallResult {
  label: string;
  ok: boolean;
  detail: string;
}

const results: CallResult[] = [];

function record(label: string, ok: boolean, detail: string) {
  results.push({ label, ok, detail });
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${label} — ${detail}`);
}

async function waitForHealth(api: AxiosInstance, attempts = 60): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await api.get('/health');
      if (res.status === 200) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`/health never became reachable at ${API_BASE}`);
}

async function registerAdmin(api: AxiosInstance): Promise<string> {
  const res = await api.post('/api/auth/register', {
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
    name: ADMIN_NAME,
    acceptTerms: true,
  });
  if (!res.data?.accessToken) {
    throw new Error(`register did not return accessToken: ${JSON.stringify(res.data)}`);
  }
  return res.data.accessToken as string;
}

async function getDefaultMcpServer(api: AxiosInstance): Promise<{
  id: string;
  slug: string;
}> {
  const res = await api.get('/api/mcp-servers');
  const servers = res.data;
  if (!Array.isArray(servers) || servers.length === 0) {
    throw new Error('expected at least one MCP server (default) after register');
  }
  return { id: servers[0].id, slug: servers[0].slug };
}

async function createConnector(
  api: AxiosInstance,
  body: Record<string, unknown>,
): Promise<string> {
  const res = await api.post('/api/connectors', body);
  if (!res.data?.id) {
    throw new Error(
      `create connector failed for ${body.name}: ${JSON.stringify(res.data)}`,
    );
  }
  return res.data.id as string;
}

async function createTool(
  api: AxiosInstance,
  connectorId: string,
  tool: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    endpointMapping: Record<string, unknown>;
  },
): Promise<void> {
  await api.post(`/api/connectors/${connectorId}/tools`, tool);
}

async function assignConnectors(
  api: AxiosInstance,
  serverId: string,
  connectorIds: string[],
): Promise<void> {
  await api.put(`/api/mcp-servers/${serverId}/connectors`, { connectorIds });
}

async function mintApiKey(
  api: AxiosInstance,
  serverId: string,
): Promise<string> {
  const res = await api.post('/api/mcp-keys', {
    name: 'smoke-test-key',
    mcpServerId: serverId,
  });
  if (!res.data?.key) {
    throw new Error(`mint key failed: ${JSON.stringify(res.data)}`);
  }
  return res.data.key as string;
}

async function callMcpTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const out = await client.callTool({ name, arguments: args });
  if ((out as { isError?: boolean }).isError) {
    throw new Error(
      `tool ${name} returned isError: ${JSON.stringify(out.content)}`,
    );
  }
  return out;
}

function extractText(out: unknown): string {
  const r = out as { content?: Array<{ type?: string; text?: string }> };
  if (!r?.content) return '';
  return r.content
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text!)
    .join('\n');
}

async function main() {
  const adminApi = axios.create({
    baseURL: API_BASE,
    validateStatus: () => true,
  });

  console.log(`[smoke] API at ${API_BASE}`);
  console.log('[smoke] Waiting for /health...');
  await waitForHealth(adminApi);

  console.log('[smoke] Registering admin...');
  const token = await registerAdmin(adminApi);
  adminApi.defaults.headers.common.Authorization = `Bearer ${token}`;

  console.log('[smoke] Resolving default MCP server...');
  const server = await getDefaultMcpServer(adminApi);
  console.log(`[smoke] Default MCP server id=${server.id} slug=${server.slug}`);

  // ---- REST ----------------------------------------------------------------
  console.log('[smoke] Creating REST connector (jsonplaceholder)...');
  const restId = await createConnector(adminApi, {
    name: 'jsonplaceholder',
    type: 'REST',
    baseUrl: 'https://jsonplaceholder.typicode.com',
    authType: 'NONE',
  });
  await createTool(adminApi, restId, {
    name: 'jph_get_post',
    description: 'Fetch a single post from JSONPlaceholder by id.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Post id (1-100)' },
      },
      required: ['id'],
    },
    endpointMapping: { method: 'GET', path: '/posts/{id}' },
  });

  // ---- SOAP ----------------------------------------------------------------
  console.log('[smoke] Creating SOAP connector (NumberConversion)...');
  const soapId = await createConnector(adminApi, {
    name: 'numberconversion',
    type: 'SOAP',
    baseUrl: 'https://www.dataaccess.com/webservicesserver/NumberConversion.wso',
    specUrl:
      'https://www.dataaccess.com/webservicesserver/NumberConversion.wso?WSDL',
    authType: 'NONE',
  });
  await createTool(adminApi, soapId, {
    name: 'number_to_words',
    description: 'Convert an unsigned integer to its English word form.',
    parameters: {
      type: 'object',
      properties: {
        ubiNum: { type: 'integer', description: 'A non-negative integer' },
      },
      required: ['ubiNum'],
    },
    endpointMapping: {
      method: 'NumberToWords',
      path: 'NumberConversionSoap',
      paramOrder: ['ubiNum'],
    },
  });

  // ---- GRAPHQL -------------------------------------------------------------
  console.log('[smoke] Creating GRAPHQL connector (countries)...');
  const gqlId = await createConnector(adminApi, {
    name: 'countries-graphql',
    type: 'GRAPHQL',
    baseUrl: 'https://countries.trevorblades.com/',
    authType: 'NONE',
  });
  await createTool(adminApi, gqlId, {
    name: 'country_by_code',
    description: 'Look up a country by ISO 3166-1 alpha-2 code.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'ISO alpha-2 code, e.g. IT' },
      },
      required: ['code'],
    },
    endpointMapping: {
      method: 'query',
      path: 'query CountryByCode($code: ID!) { country(code: $code) { name capital currency emoji } }',
      queryParams: { code: '$code' },
    },
  });

  // ---- DATABASE (MySQL) ----------------------------------------------------
  console.log('[smoke] Creating DATABASE/MySQL connector...');
  const dbId = await createConnector(adminApi, {
    name: 'mysql-smoke',
    type: 'DATABASE',
    baseUrl: 'mysql://smoke:smokepass@mysql:3306/smoketest',
    authType: 'NONE',
    config: { readOnly: true },
  });
  // The default tools auto-created for DATABASE connectors include
  // exec_sql / list_tables / describe_table. We add one bound-parameter
  // SELECT to specifically exercise the prepared-statement path.
  await createTool(adminApi, dbId, {
    name: 'find_user_by_name',
    description:
      'Find a user row by exact name match. Bound via prepared statement.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Exact user name to look up' },
      },
      required: ['name'],
    },
    endpointMapping: {
      method: 'query',
      path: 'SELECT id, name, email, active FROM users WHERE name = $name',
    },
  });

  // ---- Wire connectors to MCP server --------------------------------------
  console.log('[smoke] Assigning connectors to MCP server...');
  await assignConnectors(adminApi, server.id, [restId, soapId, gqlId, dbId]);

  console.log('[smoke] Minting MCP API key...');
  const apiKey = await mintApiKey(adminApi, server.id);

  // ---- MCP client ----------------------------------------------------------
  const mcpUrl = new URL(`/mcp/${server.id}`, API_BASE);
  console.log(`[smoke] Connecting MCP client to ${mcpUrl.toString()}`);
  const transport = new StreamableHTTPClientTransport(mcpUrl, {
    requestInit: { headers: { 'X-API-Key': apiKey } },
  });
  const client = new Client({ name: 'smoke-test-client', version: '1.0.0' });
  await client.connect(transport);

  const toolsResp = await client.listTools();
  const toolNames = toolsResp.tools.map((t) => t.name);
  console.log(`[smoke] MCP server exposes ${toolNames.length} tools: ${toolNames.join(', ')}`);

  // ---- Invoke one tool per connector --------------------------------------
  try {
    const out = await callMcpTool(client, 'jph_get_post', { id: 1 });
    const text = extractText(out);
    record(
      'REST jph_get_post',
      text.includes('"id"') && text.includes('"title"'),
      text.slice(0, 120).replace(/\s+/g, ' '),
    );
  } catch (e: any) {
    record('REST jph_get_post', false, e.message);
  }

  try {
    const out = await callMcpTool(client, 'number_to_words', { ubiNum: 42 });
    const text = extractText(out).toLowerCase();
    record(
      'SOAP number_to_words',
      text.includes('forty') && text.includes('two'),
      text.slice(0, 120).replace(/\s+/g, ' '),
    );
  } catch (e: any) {
    record('SOAP number_to_words', false, e.message);
  }

  try {
    const out = await callMcpTool(client, 'country_by_code', { code: 'IT' });
    const text = extractText(out);
    record(
      'GraphQL country_by_code',
      text.includes('Italy') || text.includes('"name"'),
      text.slice(0, 120).replace(/\s+/g, ' '),
    );
  } catch (e: any) {
    record('GraphQL country_by_code', false, e.message);
  }

  try {
    const out = await callMcpTool(client, 'find_user_by_name', {
      name: 'Alice',
    });
    const text = extractText(out);
    record(
      'MySQL prepared SELECT (alice)',
      text.includes('alice@example.com'),
      text.slice(0, 120).replace(/\s+/g, ' '),
    );
  } catch (e: any) {
    record('MySQL prepared SELECT (alice)', false, e.message);
  }

  // The injection-shaped row exists; binding the literal must return that row,
  // never execute a DROP TABLE.
  try {
    const sqliName = "x'; DROP TABLE users;--";
    const out = await callMcpTool(client, 'find_user_by_name', {
      name: sqliName,
    });
    const text = extractText(out);
    record(
      'MySQL prepared SELECT (sqli payload bound as literal)',
      text.includes('sqli@example.com'),
      text.slice(0, 120).replace(/\s+/g, ' '),
    );
  } catch (e: any) {
    record('MySQL prepared SELECT (sqli payload bound as literal)', false, e.message);
  }

  await client.close();

  console.log('\n[smoke] Summary');
  console.log('---------------');
  let failed = 0;
  for (const r of results) {
    const tag = r.ok ? '✓' : '✗';
    console.log(`  ${tag}  ${r.label}`);
    if (!r.ok) failed += 1;
  }
  console.log('---------------');
  console.log(`[smoke] ${results.length - failed}/${results.length} passed`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[smoke] Fatal error:', err);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * Standalone stdio MCP server for directory evaluation (Glama, MCP Inspector).
 *
 * Glama scores a server by building its Dockerfile, starting it, and sending
 * MCP introspection (initialize + tools/list). It requires a server that runs
 * LOCALLY and self-contained (no external endpoint proxy, no external DB).
 *
 * The full AnythingMCP gateway needs PostgreSQL to boot, so it can't run in
 * Glama's sandbox. This tiny script has NO dependency on the app, NestJS,
 * Prisma or any database — it only needs @modelcontextprotocol/sdk + zod. It
 * exposes the same static, self-describing "how to use AnythingMCP" tools as
 * the public /mcp/demo endpoint, so Glama can introspect a working server and
 * assign a quality score. It exposes no customer data.
 *
 * Run: node scripts/glama-stdio-demo.mjs   (speaks MCP over stdio)
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const SITE = 'https://anythingmcp.com';
const REPO = 'https://github.com/HelpCode-ai/anythingmcp';
const CLOUD = 'https://cloud.anythingmcp.com';

const OVERVIEW = `AnythingMCP is a self-hosted, open-source MCP gateway that turns any API, database or MCP server into custom connectors for Claude, ChatGPT, Gemini, Copilot and Cursor — no code.

This is a read-only demo server that describes the product; it exposes no customer data.

• Website: ${SITE}
• Source:  ${REPO}
• Cloud:   ${CLOUD}

Next: call "anythingmcp_get_started", "anythingmcp_connect_client", or "anythingmcp_list_connectors".`;

const GET_STARTED = `Run your own AnythingMCP in ~60 seconds:

  git clone ${REPO}.git
  cd anythingmcp && ./setup.sh

Open http://localhost:3000, register the first user (admin), import an API spec
(OpenAPI/Postman/WSDL/GraphQL) or pick a pre-built adapter, assign it to an MCP
server, then connect your AI client to http://localhost:4000/mcp.

Managed cloud: ${CLOUD} · Guides: ${SITE}/guides`;

const CONNECT = {
  claude: `Claude: Settings → Connectors → add your AnythingMCP server URL as a custom connector (OAuth 2.0 supported). Guide: ${SITE}/guides`,
  chatgpt: `ChatGPT: AnythingMCP is the MCP backend behind "apps in ChatGPT" (formerly connectors). Add it as a connector/app, or use it as the tool layer of an Apps SDK app. Guide: ${SITE}/guides`,
  gemini: `Google Gemini: point Gemini's MCP tooling at your AnythingMCP server URL over HTTP/SSE. Guide: ${SITE}/guides`,
  copilot: `GitHub Copilot: add your AnythingMCP server URL as an MCP server (Streamable HTTP). Guide: ${SITE}/guides`,
  cursor: `Cursor: add your AnythingMCP server URL as an MCP server (Streamable HTTP) in Cursor's MCP settings. Guide: ${SITE}/guides`,
};

const CONNECTORS = `AnythingMCP ships 175+ pre-built connectors. Highlights:
• Logistics & shipping — Deutsche Bahn, DHL, DPD, GLS, Sendcloud
• ERP & invoicing — weclapp, Xentral, Scopevisio, Billomat
• E-commerce — Etsy, Shopware 6, WooCommerce, Mercado Libre, ImmobilienScout24
• HR — Personio, HRWorks, Kenjo
• Government & public data — VIES VAT, Handelsregister, DESTATIS, OpenPLZ
• Banking & payments — N26, Wise, PAYONE
• Messaging — WhatsApp, LINE
• Sports & Web3 — Playtomic, Sorare

Plus 5 connector types you build with no code: REST, SOAP/WSDL, GraphQL,
Database (Postgres/MySQL/MSSQL/Oracle/MongoDB/SQLite), MCP-to-MCP bridge.
Browse all: ${SITE}/guides`;

const server = new McpServer(
  { name: 'AnythingMCP', version: '1.0.0' },
  {
    instructions:
      'Read-only demo of AnythingMCP. These tools describe the product and how ' +
      'to use it; they expose no customer data. Start with anythingmcp_overview.',
  },
);

server.tool(
  'anythingmcp_overview',
  'What AnythingMCP is and where to learn more.',
  {},
  async () => ({ content: [{ type: 'text', text: OVERVIEW }] }),
);
server.tool(
  'anythingmcp_get_started',
  'How to install and run your own AnythingMCP gateway in ~60 seconds.',
  {},
  async () => ({ content: [{ type: 'text', text: GET_STARTED }] }),
);
server.tool(
  'anythingmcp_connect_client',
  'Setup instructions to connect an AI client (Claude, ChatGPT, Gemini, Copilot, Cursor) to AnythingMCP.',
  { client: z.enum(['claude', 'chatgpt', 'gemini', 'copilot', 'cursor']).describe('Which AI client to connect.') },
  async ({ client }) => ({ content: [{ type: 'text', text: CONNECT[client] ?? CONNECT.claude }] }),
);
server.tool(
  'anythingmcp_list_connectors',
  'Overview of the 175+ pre-built connectors and the connector types you can build.',
  {},
  async () => ({ content: [{ type: 'text', text: CONNECTORS }] }),
);

await server.connect(new StdioServerTransport());

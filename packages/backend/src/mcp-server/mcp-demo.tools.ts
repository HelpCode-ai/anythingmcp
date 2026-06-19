import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * Static, self-describing tools for the PUBLIC demo MCP server (`/mcp/demo`).
 *
 * These tools return information about AnythingMCP only — they never touch the
 * database, connectors, credentials or any tenant data. The demo endpoint
 * exists so directory crawlers (Glama, Smithery, mcp.so) and curious agents can
 * introspect a working MCP server anonymously and learn how to use the product,
 * without us exposing the auth-protected per-tenant endpoints.
 */

const SITE = 'https://anythingmcp.com';
const REPO = 'https://github.com/HelpCode-ai/anythingmcp';
const CLOUD = 'https://cloud.anythingmcp.com';

const OVERVIEW = `AnythingMCP is a self-hosted, open-source MCP gateway that turns any API, database or MCP server into custom connectors for Claude, ChatGPT, Gemini, Copilot and Cursor — no code.

This is a PUBLIC, READ-ONLY demo endpoint: it only describes the product and exposes no customer data. To do real work, run your own instance (it's free, AGPL-3.0) or use the managed cloud.

• Website: ${SITE}
• Source:  ${REPO}
• Cloud:   ${CLOUD}

Next steps — call:
• "anythingmcp_get_started" to install your own gateway in ~60 seconds
• "anythingmcp_connect_client" to connect Claude / ChatGPT / Gemini / Copilot / Cursor
• "anythingmcp_list_connectors" to see the 175+ pre-built connectors`;

const GET_STARTED = `Run your own AnythingMCP in ~60 seconds:

  git clone ${REPO}.git
  cd anythingmcp && ./setup.sh

Then open http://localhost:3000 and register the first user (it becomes admin).
Import an API spec (OpenAPI/Swagger, Postman, cURL, WSDL, GraphQL) or pick a
pre-built adapter, assign it to an MCP server, and connect your AI client to
http://localhost:4000/mcp.

Prefer not to self-host? Use the managed cloud: ${CLOUD}
Full guides (EN/DE/IT): ${SITE}/guides`;

const CONNECT: Record<string, string> = {
  claude: `Claude (Desktop, Code, claude.ai): open Settings → Connectors → "Add custom connector" and paste your AnythingMCP server URL (e.g. http://localhost:4000/mcp or your cloud URL). OAuth 2.0 is supported out of the box. Guide: ${SITE}/guides`,
  chatgpt: `ChatGPT: AnythingMCP gives you the MCP backend behind "apps in ChatGPT" (formerly connectors). Add your AnythingMCP URL as a connector/app in ChatGPT's settings, or use it as the tool layer of an Apps SDK app. Guide: ${SITE}/guides`,
  gemini: `Google Gemini: point Gemini's MCP/tooling at your AnythingMCP server URL over HTTP/SSE. Guide: ${SITE}/guides`,
  copilot: `GitHub Copilot: add your AnythingMCP server URL as an MCP server (Streamable HTTP). Guide: ${SITE}/guides`,
  cursor: `Cursor: add your AnythingMCP server URL as an MCP server (Streamable HTTP) in Cursor's MCP settings. Guide: ${SITE}/guides`,
};

const CONNECTORS = `AnythingMCP ships 175+ pre-built, ready-to-use connectors. Highlights by category:

• Logistics & shipping — Deutsche Bahn, DHL, DPD, GLS, Sendcloud
• ERP, accounting & invoicing — weclapp, Xentral, Scopevisio, Billomat
• E-commerce — Etsy, Shopware 6, WooCommerce, Mercado Libre, ImmobilienScout24
• HR & field service — Personio, HRWorks, Kenjo
• Government & public data — VIES VAT, Handelsregister, DESTATIS, Bundesbank, OpenPLZ
• Banking & payments — N26, Wise, PAYONE
• Messaging — WhatsApp, LINE, TeamViewer
• Sports & Web3 — Playtomic, Sorare

Plus 5 connector types you can build yourself with no code: REST, SOAP/WSDL,
GraphQL, Database (PostgreSQL/MySQL/MSSQL/Oracle/MongoDB/SQLite) and an
MCP-to-MCP bridge. Browse everything: ${SITE}/guides`;

/**
 * Register the static demo tools on a per-request McpServer instance.
 */
export function registerDemoTools(server: McpServer): void {
  server.tool(
    'anythingmcp_overview',
    'What AnythingMCP is, what this demo endpoint does, and where to learn more.',
    {},
    async () => ({ content: [{ type: 'text' as const, text: OVERVIEW }] }),
  );

  server.tool(
    'anythingmcp_get_started',
    'How to install and run your own AnythingMCP gateway in ~60 seconds.',
    {},
    async () => ({ content: [{ type: 'text' as const, text: GET_STARTED }] }),
  );

  server.tool(
    'anythingmcp_connect_client',
    'Setup instructions to connect an AI client (Claude, ChatGPT, Gemini, Copilot, Cursor) to AnythingMCP.',
    {
      client: z
        .enum(['claude', 'chatgpt', 'gemini', 'copilot', 'cursor'])
        .describe('Which AI client to connect.'),
    },
    async ({ client }) => ({
      content: [{ type: 'text' as const, text: CONNECT[client] ?? CONNECT.claude }],
    }),
  );

  server.tool(
    'anythingmcp_list_connectors',
    'Overview of the 175+ pre-built connectors and the connector types you can build.',
    {},
    async () => ({ content: [{ type: 'text' as const, text: CONNECTORS }] }),
  );
}

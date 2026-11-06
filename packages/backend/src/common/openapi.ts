import { DocumentBuilder, type OpenAPIObject } from '@nestjs/swagger';
import { APP_VERSION } from './app-version';

/**
 * The OpenAPI document's top-level metadata, served at /api/docs (Swagger UI)
 * and /api/docs-json. Kept out of main.ts so it can be unit-tested and
 * rendered without booting the app.
 *
 * Every claim in OPENAPI_DESCRIPTION is backed by code; keep it that way when
 * behaviour changes:
 *   - auth and key scopes:      auth/jwt-or-management-key.guard.ts
 *   - per-key rate limit:       same file (MANAGEMENT_RATE_LIMIT_PER_MINUTE)
 *   - per-IP rate limit:        app.module.ts (ThrottlerModule.forRoot)
 *   - key minting rules:        roles/mcp-api-keys.controller.ts
 *   - code mode values:         mcp-server/code-tool.util.ts (CODE_MODE_MODES)
 */

export const OPENAPI_REPO_URL = 'https://github.com/HelpCode-ai/anythingmcp';
export const OPENAPI_API_DOCS_URL = 'https://anythingmcp.com/developers/api';
export const OPENAPI_CLI_DOCS_URL = 'https://anythingmcp.com/developers/cli';

/** Name of the `X-API-Key` security scheme, referenced by `@ApiSecurity('api-key')`. */
export const API_KEY_SCHEME = 'api-key';

/**
 * Every tag a controller uses in `@ApiTags(...)`, in the order Swagger UI shows
 * them: the management resources integrators and the `amcp` CLI use most come
 * first. openapi.spec.ts fails when a controller uses a tag missing here, or
 * when a tag here is used by no controller.
 */
export const OPENAPI_TAGS: ReadonlyArray<{ name: string; description: string }> = [
  {
    name: 'Connectors',
    description:
      'The systems AnythingMCP calls (REST, SOAP, GraphQL, OData, databases, mail, remote MCP servers): create, import tools from a spec, test, health-check, export and restore.',
  },
  {
    name: 'Adapters',
    description:
      'The built-in connector catalogue: browse it, read an adapter, verify credentials, and install it as a ready-to-use connector in one call.',
  },
  {
    name: 'Tools',
    description:
      'The MCP tools of one connector: create, edit, enable or disable, annotations, response mapping and proxy settings.',
  },
  {
    name: 'MCP Servers',
    description:
      'MCP endpoints (`/mcp/<serverId>`), each exposing a chosen set of connectors to AI clients, with its own instructions, skills delivery and code mode.',
  },
  {
    name: 'MCP API Keys',
    description:
      'Your personal `mcp_…` keys: `MCP` scope for AI clients, `MANAGEMENT_READ` / `MANAGEMENT_ADMIN` for this API and the `amcp` CLI.',
  },
  {
    name: 'MCP Connections',
    description:
      'AI clients connected over OAuth to the shared `/mcp` endpoint, and which workspaces and MCP servers each one may reach.',
  },
  {
    name: 'MCP Endpoint',
    description:
      'The Model Context Protocol endpoints AI clients connect to (Streamable HTTP, JSON-RPC): `/mcp/{serverId}` per server, the shared `/mcp`, and `/mcp/demo`. Use an MCP client, not plain REST calls; sign in with OAuth or send an MCP API key.',
  },
  {
    name: 'Roles',
    description:
      'Role-based access to tools: which tools each MCP role may call and which roles each member holds. Admin only.',
  },
  {
    name: 'Users',
    description:
      'Your own profile, and (admin) the workspace members, invitations, roles, sessions and deactivation.',
  },
  {
    name: 'Audit',
    description:
      'The log of every tool call with input, output, status and duration, plus usage statistics, daily analytics and per-connector / server / user breakdowns.',
  },
  {
    name: 'Organizations',
    description:
      'Workspaces: the ones you belong to, switching between them, creating one (Cloud), and updating or deleting the current one.',
  },
  {
    name: 'Identity Providers',
    description:
      'Single sign-on providers (Entra ID, Google, Okta, Auth0, GitHub, generic OIDC), group-to-role mappings, SSO enforcement and SCIM provisioning. Admin, self-hosted.',
  },
  {
    name: 'SSO',
    description: 'Signing in through an identity provider, and linking one to your own account.',
  },
  {
    name: 'Auth',
    description:
      'Dashboard sign-up, sign-in, sessions, email verification, password reset and social sign-in.',
  },
  {
    name: 'Memory',
    description:
      'Personal and company memory that every AI client shares: items, approval of company items, and access settings.',
  },
  {
    name: 'Knowledge Graph',
    description:
      'How your connectors and tools relate, and the AI skills (procedures) agents follow: suggest, generate, create, apply or dismiss.',
  },
  {
    name: 'Knowledge folders',
    description: 'Folders that organise skills and company memory, optionally limited to roles.',
  },
  {
    name: 'File Search',
    description:
      'File Search connectors over SFTP, FTP/FTPS, WebDAV, S3 or a mounted network share: test, save, scan, choose what to index, and policy.',
  },
  {
    name: 'File Share',
    description:
      'Temporary download links for files from your folders or written by the AI, internal or public, with limits and revoke.',
  },
  {
    name: 'MCP OAuth',
    description:
      'OAuth redirect targets for connectors that sign in at the provider, shared or per user.',
  },
  {
    name: 'MCP client sign-in',
    description:
      'Browser pages of the OAuth flow in which an AI client signs in to AnythingMCP and the user picks what it may reach.',
  },
  {
    name: 'OAuth discovery',
    description:
      'OAuth and OpenID discovery documents (`/.well-known/…`) that MCP clients read before signing in.',
  },
  {
    name: 'Shopee',
    description: 'Shop authorization for Shopee connectors.',
  },
  {
    name: 'TikTok Shop',
    description: 'Shop authorization and TikTok Shop App Store installs for TikTok Shop connectors.',
  },
  {
    name: 'Alerts',
    description: 'The webhook notified when a connector starts failing. Admin only.',
  },
  {
    name: 'Site Settings',
    description:
      'Workspace and instance settings: SMTP, footer links and the SSRF allowlist (admin), plus the public footer links.',
  },
  {
    name: 'License',
    description:
      'Edition, licence and plan status, usage against plan limits, trials and billing links.',
  },
  {
    name: 'Support',
    description: 'Support chat widget settings and its inbound webhook.',
  },
  {
    name: 'Health',
    description: 'Liveness / readiness check (`/health`) and public server information.',
  },
  {
    name: 'Version',
    description: 'Version, commit and build date of this instance.',
  },
  {
    name: 'Public',
    description: 'Public aggregate numbers, for the website.',
  },
  {
    name: 'Cron',
    description: 'Scheduled jobs triggered by the AnythingMCP Cloud scheduler. Internal.',
  },
];

export const OPENAPI_DESCRIPTION = `
**AnythingMCP** is an open-source agent harness and MCP gateway. It turns any REST/OpenAPI, SOAP/WSDL, GraphQL or OData API, SaaS app, SQL or NoSQL database, mail server or file share (SFTP, FTP/FTPS, WebDAV, S3, a mounted network share) into [Model Context Protocol](https://modelcontextprotocol.io) tools that AI agents such as Claude, ChatGPT, Copilot, Cursor and Gemini can call, with governance on top.

This API is what the dashboard and the [\`amcp\` CLI](${OPENAPI_CLI_DOCS_URL}) use. With it you can:

- **Connectors**: install a ready-made connector from the built-in catalogue (\`/api/adapters\`), or build your own and import its tools from OpenAPI, WSDL, GraphQL, OData, Postman, cURL, HAR, JSON or another MCP server.
- **MCP servers**: publish MCP endpoints at \`/mcp/<serverId>\`, each exposing a chosen set of connectors, with instructions, skills and **code mode** (\`codeMode\`: \`off\` no code execution, \`tools\` saved code tools only, \`inline\` also the generic \`code_execute\` / \`code_propose_tool\`).
- **Governance**: roles with per-tool access, SSO and SCIM, per-user credentials and OAuth sign-in, an audit log of every tool call with usage analytics.
- **Company brain**: memory, AI skills, the knowledge graph, File Search and File Share.

AnythingMCP runs on [AnythingMCP Cloud](https://cloud.anythingmcp.com) or self-hosted (AGPL-3.0, [source on GitHub](${OPENAPI_REPO_URL})). Cloud base URL: \`https://cloud.anythingmcp.com\`; a self-hosted backend listens on \`http://localhost:4000\` by default.

## Authentication

Routes marked with a lock need one of these credentials:

| Credential | How to send it | Notes |
|---|---|---|
| Management API key \`mcp_…\` | \`Authorization: Bearer mcp_…\` **or** \`X-API-Key: mcp_…\` | Recommended for scripts, CI and agents. |
| Dashboard session JWT | \`Authorization: Bearer <jwt>\` | The \`accessToken\` returned by \`POST /api/auth/login\`. |

Key scopes:

- \`MCP\`: tool calls on \`/mcp\` only. **Rejected on \`/api\`** (401).
- \`MANAGEMENT_READ\`: \`GET\` and \`HEAD\` only; any other method gets 403.
- \`MANAGEMENT_ADMIN\`: any method. Only an admin can create one.

A key acts as its owner, with the owner's role in the key's workspace. The scope only narrows what the owner can do and never adds to it: routes marked *(ADMIN)* still need an admin owner, and a \`VIEWER\` still cannot change connectors.

Create a key with \`POST /api/mcp-keys\` (\`{"name": "ci", "scope": "MANAGEMENT_READ"}\`), in the dashboard, or with \`amcp login --browser --url <instance-url> [--scope admin]\`. The full key is returned only once.

An API key works on the routes that list the \`api-key\` scheme. The routes of the **Auth**, **SSO**, **MCP OAuth**, **Shopee**, **TikTok Shop** and **Support** tags, and a few others, accept only a dashboard session. Routes without a lock need no credential, except a few browser redirect routes of the MCP OAuth, Shopee and TikTok Shop tags.

## Quick start

\`\`\`bash
export AMCP_URL=https://cloud.anythingmcp.com   # or your self-hosted URL
export AMCP_API_KEY=mcp_…                       # a MANAGEMENT_ADMIN key

# Who am I?
curl -s "$AMCP_URL/api/users/me" -H "Authorization: Bearer $AMCP_API_KEY"

# List connectors (paginated: limit 1..200, offset)
curl -s "$AMCP_URL/api/connectors?limit=50" -H "X-API-Key: $AMCP_API_KEY"

# Read a catalogue adapter (required variables, tools), then install it
curl -s "$AMCP_URL/api/adapters/hubspot" -H "Authorization: Bearer $AMCP_API_KEY"
curl -s -X POST "$AMCP_URL/api/adapters/hubspot/import" \\
  -H "Authorization: Bearer $AMCP_API_KEY" -H "Content-Type: application/json" \\
  -d '{"credentials": {"HUBSPOT_ACCESS_TOKEN": "pat-eu1-…"}}'
# → {"connectorId": "…", "toolsCreated": 14, "attachedToServer": {…}, "probe": {"ok": true, …}}

# Create an MCP server and put connectors on it (the list replaces the current one)
curl -s -X POST "$AMCP_URL/api/mcp-servers" \\
  -H "Authorization: Bearer $AMCP_API_KEY" -H "Content-Type: application/json" \\
  -d '{"name": "Sales", "description": "CRM tools for the sales team"}'
curl -s -X PUT "$AMCP_URL/api/mcp-servers/<serverId>/connectors" \\
  -H "Authorization: Bearer $AMCP_API_KEY" -H "Content-Type: application/json" \\
  -d '{"connectorIds": ["<connectorId>"]}'

# Turn on code mode for that server
curl -s -X PUT "$AMCP_URL/api/mcp-servers/<serverId>" \\
  -H "Authorization: Bearer $AMCP_API_KEY" -H "Content-Type: application/json" \\
  -d '{"codeMode": "inline"}'

# Mint an MCP key for an AI client; it then connects to $AMCP_URL/mcp/<serverId>
curl -s -X POST "$AMCP_URL/api/mcp-keys" \\
  -H "Authorization: Bearer $AMCP_API_KEY" -H "Content-Type: application/json" \\
  -d '{"name": "claude-desktop", "mcpServerId": "<serverId>", "scope": "MCP"}'

# The last 20 failed tool calls
curl -s "$AMCP_URL/api/audit/invocations?status=ERROR&limit=20" -H "Authorization: Bearer $AMCP_API_KEY"
\`\`\`

The same with the CLI (\`npm i -g @anythingmcp/cli\`). \`amcp api --list\` prints every operation it can call, offline:

\`\`\`bash
amcp login --browser --url https://cloud.anythingmcp.com --scope admin
amcp api GET /api/users/me
amcp api GET "/api/connectors?limit=50"
amcp api POST /api/adapters/hubspot/import --data '{"credentials": {"HUBSPOT_ACCESS_TOKEN": "pat-eu1-…"}}' --yes
amcp api POST /api/mcp-servers --data '{"name": "Sales"}' --yes
amcp api PUT /api/mcp-servers/<serverId>/connectors --data '{"connectorIds": ["<connectorId>"]}' --yes
amcp api PUT /api/mcp-servers/<serverId> --data '{"codeMode": "inline"}' --yes
amcp api GET "/api/audit/invocations?status=ERROR&limit=20"
\`\`\`

In CI, set \`AMCP_URL\` and \`AMCP_API_KEY\` instead of logging in. The CLI asks before any method other than \`GET\`; \`--yes\` skips the question.

## Rate limits

- Per client IP: 100 requests a minute across the API (a few routes allow less, and the public adapter catalogue is not limited).
- Per management API key: 300 requests a minute by default (\`MANAGEMENT_RATE_LIMIT_PER_MINUTE\` on self-hosted; \`0\` turns it off).

Over a limit the API answers **429**; wait for the time in the \`Retry-After\` header (or the \`retryAfter\` field) before retrying.

## Errors

Errors are JSON: \`{"statusCode": 404, "message": "MCP server not found", "error": "Not Found"}\`.

| Status | Meaning |
|---|---|
| 400 | Invalid body or query. Unknown fields are rejected; \`message\` lists what is wrong. |
| 401 | Missing, invalid or revoked credential, or an \`MCP\`-scoped key used on \`/api\`. |
| 403 | Authenticated but not allowed: a read-only key on a write, a \`VIEWER\` changing something, a non-admin on an *(ADMIN)* route, a plan limit, or a connector of another workspace. |
| 404 | No such resource in your workspace. |
| 409 | Conflict, e.g. an MCP server slug already used in the workspace. |
| 422 | A remote spec could not be fetched or parsed (\`POST /api/connectors/{id}/import-spec\`). |
| 429 | Rate limit reached; see above. |

Some import and discovery routes (\`POST /api/connectors/{id}/import\` and \`/discover-tools\`, and \`/import-spec\` for a connector without a spec) answer with a success status (201) and \`{"error": "…"}\` when the spec or the remote server cannot be read: check the body for an \`error\` field.

## More

- API guide: ${OPENAPI_API_DOCS_URL}
- CLI guide: ${OPENAPI_CLI_DOCS_URL}
- Source, issues and self-hosting: ${OPENAPI_REPO_URL}
`.trim();

/** The DocumentBuilder output for SwaggerModule.createDocument. */
export function buildOpenApiConfig(
  version: string = APP_VERSION,
): Omit<OpenAPIObject, 'paths'> {
  const builder = new DocumentBuilder()
    .setTitle('AnythingMCP API')
    .setDescription(OPENAPI_DESCRIPTION)
    .setVersion(version)
    .setContact('AnythingMCP', 'https://anythingmcp.com', 'info@helpcode.ai')
    .setLicense('AGPL-3.0', `${OPENAPI_REPO_URL}/blob/main/LICENSE`)
    .setExternalDoc('AnythingMCP API guide', OPENAPI_API_DOCS_URL)
    // Default scheme name 'bearer', referenced by @ApiBearerAuth().
    .addBearerAuth({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT or mcp_ key',
      description:
        'A management-scoped API key (`mcp_…`, scope MANAGEMENT_READ or MANAGEMENT_ADMIN) ' +
        'or a dashboard session JWT. Paste the value without the "Bearer " prefix.',
    })
    .addApiKey(
      {
        type: 'apiKey',
        name: 'X-API-Key',
        in: 'header',
        description:
          'A management-scoped API key (`mcp_…`, scope MANAGEMENT_READ or MANAGEMENT_ADMIN), ' +
          'as an alternative to the bearer header. Accepted only on routes that also list this scheme.',
      },
      API_KEY_SCHEME,
    );
  for (const tag of OPENAPI_TAGS) builder.addTag(tag.name, tag.description);
  return builder.build();
}

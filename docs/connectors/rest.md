# REST Connector — REST API to MCP

> Convert any REST API into MCP tools. Import from OpenAPI, Postman, cURL, or define tools manually.

[Back to README](../../README.md)

---

## 3-minute quickstart

Goal: go from a running AnythingMCP instance to a working MCP tool call against a public API, without writing code.

1. **Register** at `http://localhost:3000` (the first account becomes Admin).
2. **Create a connector**: *Connectors → New Connector → REST*. Name it `VIES VAT`, Base URL `https://ec.europa.eu/taxation_customs/vies/rest-api`, Auth type `None`. Save.
3. **Import the spec**: on the connector page, *Import → OpenAPI URL*, paste `https://ec.europa.eu/taxation_customs/vies/rest-api/openapi.json`. AnythingMCP generates one tool per operation. Toggle the tools you want exposed.
4. **Issue an MCP API key**: *Profile → MCP API Keys → New Key*. Copy the value.
5. **Point your MCP client at it**. For Claude Desktop, add to `claude_desktop_config.json`:
   ```json
   {
     "mcpServers": {
       "anythingmcp": {
         "url": "http://localhost:4000/mcp",
         "headers": { "Authorization": "Bearer <your-mcp-key>" }
       }
     }
   }
   ```
   Restart Claude Desktop, then ask: *"Use AnythingMCP to validate VAT number DE123456789."* The tool call appears in the audit log at `/audit`.

If you'd rather use a pre-built adapter (DHL, DPD, Personio, VIES, …) instead of importing from a spec, see [Pre-configured MCP Connectors](../../README.md#pre-configured-mcp-connectors) — those skip steps 2–3.

---

## Overview

The REST connector lets you expose HTTP-based APIs as MCP tools. It supports all HTTP methods, authentication types, and can auto-import tool definitions from multiple formats.

**Keywords:** REST API to MCP, OpenAPI to MCP, Swagger to MCP, Postman to MCP, cURL to MCP, HTTP API MCP bridge

---

## Creating a REST Connector

### Via Web UI

1. Go to **Connectors** > **New Connector**
2. Select **REST** as the type
3. Enter the **Base URL** (e.g., `https://api.example.com`)
4. Configure authentication (see [Auth Types](#authentication))
5. Click **Create**

### Via API

```bash
TOKEN=$(curl -s http://localhost:4000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.com","password":"your-password"}' \
  | jq -r '.accessToken')

curl -s http://localhost:4000/api/connectors \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "My REST API",
    "type": "REST",
    "baseUrl": "https://api.example.com",
    "authType": "BEARER_TOKEN",
    "authConfig": {
      "token": "your-api-token"
    }
  }'
```

---

## Importing Tools

### From OpenAPI / Swagger

Paste the spec URL or JSON/YAML content. Tools are auto-generated for each `path + method` with:
- Tool name from `operationId`
- Parameters from path params, query params, and request body
- Endpoint mapping auto-configured

```bash
# Import from URL
curl -s http://localhost:4000/api/connectors/$CONNECTOR_ID/import-spec \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"specUrl": "https://petstore.swagger.io/v2/swagger.json"}'
```

### From Postman Collection

Supports Postman Collection v2.1 format, including:
- Nested folders (flattened with folder prefixes)
- All auth types (Bearer, Basic, API Key, OAuth2)
- Body modes: raw JSON, form-data, urlencoded
- Variable interpolation (`{{var}}` → tool parameters)

```bash
curl -s http://localhost:4000/api/connectors/$CONNECTOR_ID/import \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "source": "postman",
    "url": "https://www.getpostman.com/collections/your-collection-id"
  }'
```

### From cURL Commands

Paste one or more cURL commands. Supports:
- `-X` method, `-H` headers, `-d` body
- `-u` basic auth
- Multiline with `\` continuation
- `{{var}}` patterns auto-detected as tool parameters

```bash
curl -X POST https://api.example.com/users \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer {{token}}' \
  -d '{"name": "{{name}}", "email": "{{email}}"}'
```

This generates a tool with `token`, `name`, and `email` as parameters.

### Custom JSON Definition

Define tools directly as JSON:

```json
{
  "tools": [
    {
      "name": "get_user",
      "description": "Get user by ID",
      "parameters": {
        "type": "object",
        "properties": {
          "id": { "type": "integer", "description": "User ID" }
        },
        "required": ["id"]
      },
      "endpointMapping": {
        "method": "GET",
        "path": "/users/{id}"
      }
    }
  ]
}
```

---

## Tool Configuration

### Endpoint Mapping

The `endpointMapping` defines how MCP tool parameters map to the HTTP request:

```json
{
  "method": "POST",
  "path": "/users/{user_id}/orders",
  "queryParams": {
    "page": "$page",
    "limit": "$limit"
  },
  "bodyMapping": {
    "productId": "$product_id",
    "quantity": "$qty"
  },
  "headers": {
    "X-Request-ID": "$request_id"
  }
}
```

| Pattern | Location | Description |
|---------|----------|-------------|
| `{param}` in path | URL path | Replaced in the URL: `/users/{id}` → `/users/123` |
| `"$param"` in queryParams | Query string | Added as `?param=value` |
| `"$param"` in bodyMapping | JSON body | Included in request body |
| `"$param"` in headers | HTTP headers | Sent as request header |

### Response Mapping

Optionally shape the API response before it reaches the AI client. Without it,
the raw upstream response is returned unchanged.

APIs routinely return far more than a tool needs — a Datto RMM device carries up
to 300 UDF fields, IPs and remote-control URLs when the tool only wants hostname,
site, OS and status. Every extra byte is billed to the agent's context window and
exposed to a third-party model. A response mapping declares what a tool actually
publishes.

```json
{
  "responseMapping": {
    "transform": {
      "select": {
        "page": {
          "count": "$.pageDetails.count",
          "totalCount": "$.pageDetails.totalCount",
          "nextPageUrl": "$.pageDetails.nextPageUrl"
        },
        "devices": {
          "$from": "$.devices[*]",
          "$select": {
            "id": "id",
            "hostname": "hostname",
            "siteName": "siteName",
            "category": "deviceType.category",
            "operatingSystem": "operatingSystem",
            "online": "online",
            "antivirusStatus": "antivirus.antivirusStatus"
          }
        }
      },
      "exclude": ["devices[*].udf"]
    }
  }
}
```

#### `transform` keys

| Key | Meaning |
|-----|---------|
| `select` | Output template. Keys are the output names; leaf syntax below. |
| `include` | Keep only these paths, preserving the original document shape. |
| `exclude` | Drop these paths. Applied **before** `include` / `select`. |
| `expression` | A [JMESPath](https://jmespath.org) expression, with `"mode": "jmespath"`. Use it for computed values (`length(devices)`) and filters (``devices[?online == `false`]``). |
| `mode` | `select` (default), `jmespath`, or `off` to keep the config without applying it. |
| `fallbackToRaw` | Default `true`: a mapping that fails returns the raw response and logs a warning rather than failing the call. Set `false` to surface the error instead. |
| `maxBytes` | Hard cap on the serialized output. `0` / absent = no cap. On overflow the result is replaced by `{ "_truncated": true, … }`. |

#### Leaf syntax in `select`

| Leaf | Result |
|------|--------|
| `"$.a.b"` / `"a.b"` | Value at that path. A leading `$.` is optional. |
| `"items[*].id"` | Array of `id` over `items` — elements without the field are skipped. |
| `"items[0].id"`, `"items[-1].id"` | Index access; negative counts from the end. |
| `"a['weird.key']"` | Quoted segment, for keys containing dots. |
| `"= my-source"` | Static string literal (`= ` prefix), for constants. |
| `42`, `true`, `null` | Passed through as-is. |
| `{ "$from": "path[*]", "$select": { … } }` | Reshape every element of an array. Optional `$limit` caps how many. |

A path that does not resolve leaves its key **out** of the output rather than
emitting `null` — that is what keeps mapped responses small.

Response mapping applies to every connector type, not just REST.

#### Legacy shape

`{"type": "json", "fields": [...]}` is still honoured and behaves as
`transform.include`.

#### Editing and previewing

- UI: **Connector → tool → Edit → Response Mapping**. "Preview with last real
  response" maps the most recent recorded response for that tool without calling
  the API again, and shows the size delta.
- API: `PATCH /api/connectors/:id/tools/:toolId/response-mapping` sets or clears
  it, `POST .../preview-mapping` dry-runs one. The tool test endpoint returns
  both `result` (raw) and `mapped`.

---

## Authentication

| Auth Type | Config |
|-----------|--------|
| **None** | `"authType": "NONE"` |
| **API Key** | `"authType": "API_KEY", "authConfig": {"key": "X-API-Key", "value": "your-key"}` |
| **Bearer Token** | `"authType": "BEARER_TOKEN", "authConfig": {"token": "your-token"}` |
| **Basic Auth** | `"authType": "BASIC_AUTH", "authConfig": {"username": "user", "password": "pass"}` |
| **OAuth2** | `"authType": "OAUTH2", "authConfig": {"clientId": "...", "clientSecret": "...", "authorizationUrl": "...", "tokenUrl": "...", "scopes": "read write"}` |

All credentials are encrypted with AES-256-GCM at rest.

### OAuth2 Authorization Flow

OAuth2 connectors use the **Authorization Code + PKCE** flow:

1. Create the connector with `authType: "OAUTH2"` and fill in `clientId`, `clientSecret`, `authorizationUrl`, `tokenUrl`, and optionally `scopes`.
2. Register **`http://localhost:4000/api/mcp-oauth/callback`** as the redirect URI in your OAuth provider settings (use your `SERVER_URL` in production).
3. From the connector detail page, click **Authorize with Provider** — you will be redirected to the provider's login/consent screen.
4. After consent, the backend exchanges the authorization code for access and refresh tokens (stored encrypted).
5. On 401 responses, the engine automatically refreshes the token using the stored refresh token and retries the request.

#### Token endpoint authentication (`client_secret_basic`)

By default the client credentials are sent **in the body** of the token request (`client_secret_post`).
Some providers — **Datto RMM** and **DATEV** among them — only accept them as an **HTTP Basic header**
(`Authorization: Basic base64(client_id:client_secret)`, RFC 6749 §2.3.1) and answer anything else with
`401` at the code-exchange step.

Pick the method in the connector form under **Token endpoint authentication**, or set it directly:

```bash
curl -s -X PATCH http://localhost:4000/api/connectors/$CONNECTOR_ID/oauth-config \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"tokenAuthMethod": "client_secret_basic"}'
```

Notes:

- The setting applies to **both** the initial authorization-code exchange **and** later refreshes.
- `PATCH .../oauth-config` merges — it will not drop the tokens already issued or the endpoints captured
  during authorization. Send `""` to go back to the default.
- `GET .../oauth-config` returns the current settings; the client secret and tokens are never returned,
  only `hasClientSecret` / `hasAccessToken` / `hasRefreshToken` booleans.
- After switching the method, re-run **Authorize with Provider** so a token is fetched the new way.

Example — Datto RMM:

| Field | Value |
|---|---|
| Authorization URL | `https://<zone>-api.centrastage.net/auth/oauth/authorize` |
| Token URL | `https://<zone>-api.centrastage.net/auth/oauth/token` |
| Client ID / Secret | `public-client` / `public` |
| Token endpoint authentication | **HTTP Basic header** |

The API key and secret key of the technical user are entered on the provider's own consent screen.

---

## Environment Variables

Define per-connector environment variables for secrets that should be injected at runtime but hidden from the AI:

```bash
curl -s -X PUT http://localhost:4000/api/connectors/$CONNECTOR_ID/env-vars \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "envVars": {
      "API_SECRET": "my-secret-value",
      "TENANT_ID": "abc-123"
    }
  }'
```

Use `{{VAR_NAME}}` in endpoint mappings. Parameters matching env var names are automatically stripped from the tool schema.

---

## Example: Full REST API Setup

```bash
# 1. Create connector
CONNECTOR_ID=$(curl -s http://localhost:4000/api/connectors \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "JSONPlaceholder",
    "type": "REST",
    "baseUrl": "https://jsonplaceholder.typicode.com",
    "authType": "NONE"
  }' | jq -r '.id')

# 2. Bulk create tools
curl -s http://localhost:4000/api/connectors/$CONNECTOR_ID/tools/bulk \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "tools": [
      {
        "name": "list_posts",
        "description": "List all posts, optionally filter by user",
        "parameters": {
          "type": "object",
          "properties": {
            "userId": { "type": "integer", "description": "Filter by user ID" }
          }
        },
        "endpointMapping": {
          "method": "GET",
          "path": "/posts",
          "queryParams": { "userId": "$userId" }
        }
      },
      {
        "name": "get_post",
        "description": "Get a single post by ID",
        "parameters": {
          "type": "object",
          "properties": {
            "id": { "type": "integer", "description": "Post ID" }
          },
          "required": ["id"]
        },
        "endpointMapping": {
          "method": "GET",
          "path": "/posts/{id}"
        }
      },
      {
        "name": "create_post",
        "description": "Create a new blog post",
        "parameters": {
          "type": "object",
          "properties": {
            "title": { "type": "string", "description": "Post title" },
            "body": { "type": "string", "description": "Post content" },
            "userId": { "type": "integer", "description": "Author user ID" }
          },
          "required": ["title", "body", "userId"]
        },
        "endpointMapping": {
          "method": "POST",
          "path": "/posts",
          "bodyMapping": {
            "title": "$title",
            "body": "$body",
            "userId": "$userId"
          }
        }
      }
    ]
  }'
```

---

[Back to README](../../README.md) | [Tool Definition Format](../tool-definition.md) | [API Reference](../api-reference.md)

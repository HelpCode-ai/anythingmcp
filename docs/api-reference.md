# API Reference

> Full REST API reference for AnythingMCP. All endpoints require JWT authentication unless noted.

[Back to README](../README.md)

---

## Authentication

Get a JWT token via login, then include it in all requests:

```bash
TOKEN=$(curl -s http://localhost:4000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.com","password":"your-password"}' \
  | jq -r '.accessToken')

# Use in subsequent requests
curl -H "Authorization: Bearer $TOKEN" http://localhost:4000/api/connectors
```

Interactive Swagger docs are available at `http://localhost:4000/api/docs`.

---

## Auth Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/auth/register` | None | Register (first user becomes Admin) |
| POST | `/api/auth/login` | None | Login, returns JWT token |
| POST | `/api/auth/invite` | Admin | Invite a user via email |
| GET | `/api/auth/invite/verify` | None | Verify an invitation token |
| POST | `/api/auth/accept-invite` | None | Accept invitation and create account |
| POST | `/api/auth/forgot-password` | None | Request a password reset email |
| POST | `/api/auth/reset-password` | None | Reset password with token |

### Register

```bash
curl -s http://localhost:4000/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.com","password":"your-password","name":"Admin User"}'
```

### Login

```bash
curl -s http://localhost:4000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.com","password":"your-password"}'
```

Response:
```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIs..."
}
```

### Invite User (Admin)

```bash
curl -s http://localhost:4000/api/auth/invite \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"email":"user@example.com","role":"EDITOR","mcpRoleId":"optional-role-id"}'
```

---

## Connector Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/connectors` | List all connectors |
| POST | `/api/connectors` | Create a connector |
| GET | `/api/connectors/:id` | Get connector with tools |
| PUT | `/api/connectors/:id` | Update connector |
| DELETE | `/api/connectors/:id` | Delete connector (cascades tools) |
| POST | `/api/connectors/:id/test` | Test API connection |
| POST | `/api/connectors/:id/import-spec` | Auto-import tools from connector's spec URL |
| POST | `/api/connectors/:id/import` | Import tools from any source |
| PUT | `/api/connectors/:id/env-vars` | Set environment variables |
| POST | `/api/connectors/:id/oauth/authorize` | Start OAuth2 authorization flow (returns redirect URL) |
| GET | `/api/mcp-oauth/callback` | OAuth2 callback — exchanges code for tokens |

### Create Connector

```bash
curl -s http://localhost:4000/api/connectors \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "My API",
    "type": "REST",
    "baseUrl": "https://api.example.com",
    "authType": "BEARER_TOKEN",
    "authConfig": {"token": "api-token"},
    "specUrl": "https://api.example.com/openapi.json"
  }'
```

**Connector types:** `REST`, `SOAP`, `GRAPHQL`, `DATABASE`, `MCP`

**Auth types:** `NONE`, `API_KEY`, `BEARER_TOKEN`, `BASIC_AUTH`, `OAUTH2`, `WS_SECURITY`, `CERTIFICATE`, `CONNECTION_STRING`

### Import Tools

```bash
# From OpenAPI/Swagger spec URL
curl -s http://localhost:4000/api/connectors/$ID/import-spec \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"specUrl": "https://api.example.com/openapi.json"}'

# From Postman collection
curl -s http://localhost:4000/api/connectors/$ID/import \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"source": "postman", "url": "https://postman.com/collections/abc123"}'

# From cURL commands
curl -s http://localhost:4000/api/connectors/$ID/import \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"source": "curl", "content": "curl -X GET https://api.example.com/users"}'

# From GraphQL introspection
curl -s http://localhost:4000/api/connectors/$ID/import \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"source": "graphql", "url": "https://api.example.com/graphql"}'

# From WSDL
curl -s http://localhost:4000/api/connectors/$ID/import \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"source": "wsdl", "url": "https://service.example.com/api?wsdl"}'

# From custom JSON
curl -s http://localhost:4000/api/connectors/$ID/import \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"source": "json", "content": "[{\"name\":\"tool\",\"description\":\"desc\",...}]"}'
```

### Set Environment Variables

```bash
curl -s -X PUT http://localhost:4000/api/connectors/$ID/env-vars \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"envVars": {"API_SECRET": "value", "TENANT_ID": "abc"}}'
```

---

## Tool Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/connectors/:id/tools` | List tools for connector |
| POST | `/api/connectors/:id/tools` | Create a single tool |
| POST | `/api/connectors/:id/tools/bulk` | Bulk create tools |
| PUT | `/api/connectors/:id/tools/:toolId` | Update a tool |
| DELETE | `/api/connectors/:id/tools/:toolId` | Delete a tool |

### Create Tool

```bash
curl -s http://localhost:4000/api/connectors/$ID/tools \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "get_user",
    "description": "Get user by ID",
    "parameters": {
      "type": "object",
      "properties": {
        "id": {"type": "integer", "description": "User ID"}
      },
      "required": ["id"]
    },
    "endpointMapping": {
      "method": "GET",
      "path": "/users/{id}"
    }
  }'
```

### Bulk Create Tools

```bash
curl -s http://localhost:4000/api/connectors/$ID/tools/bulk \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"tools": [...]}'
```

See [Tool Definition Format](tool-definition.md) for the full schema.

---

## MCP Server Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/mcp-servers` | List MCP server configurations |
| POST | `/api/mcp-servers` | Create MCP server config |
| PUT | `/api/mcp-servers/:id` | Update MCP server config |
| DELETE | `/api/mcp-servers/:id` | Delete MCP server config |

---

## Audit Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/audit/invocations` | List invocations (with filters) |
| GET | `/api/audit/stats` | Get invocation stats (24h, 7d, total) |

### Query Invocations

```bash
# Filter by tool name
curl -s "http://localhost:4000/api/audit/invocations?toolName=get_user" \
  -H "Authorization: Bearer $TOKEN"

# Filter by date range
curl -s "http://localhost:4000/api/audit/invocations?from=2026-01-01&to=2026-01-31" \
  -H "Authorization: Bearer $TOKEN"
```

### Get Stats

```bash
curl -s http://localhost:4000/api/audit/stats \
  -H "Authorization: Bearer $TOKEN"
```

Response:
```json
{
  "last24h": 142,
  "last7d": 1053,
  "total": 8721
}
```

---

## Roles & Access Control

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/roles` | List all roles |
| POST | `/api/roles` | Create a custom role |
| PUT | `/api/roles/:id` | Update a role |
| DELETE | `/api/roles/:id` | Delete a role |
| GET | `/api/roles/:id/tools` | List tool access for a role |
| PUT | `/api/roles/:id/tools` | Set tool access whitelist |

### Create Role with Tool Whitelist

```bash
# 1. Create role
ROLE_ID=$(curl -s http://localhost:4000/api/roles \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name": "Sales Team", "description": "Access to CRM tools only"}' \
  | jq -r '.id')

# 2. Set tool whitelist
curl -s -X PUT http://localhost:4000/api/roles/$ROLE_ID/tools \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"toolIds": ["tool-id-1", "tool-id-2", "tool-id-3"]}'
```

---

## MCP API Keys

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/mcp-api-keys` | List your MCP API keys |
| POST | `/api/mcp-api-keys` | Generate a new MCP API key |
| DELETE | `/api/mcp-api-keys/:id` | Revoke an MCP API key |

### Generate API Key

```bash
curl -s http://localhost:4000/api/mcp-api-keys \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name": "My Claude Desktop Key", "mcpServerId": "optional-server-id"}'
```

---

## Site Settings (Admin)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/settings/smtp` | Get SMTP configuration |
| PUT | `/api/settings/smtp` | Update SMTP configuration |
| POST | `/api/settings/smtp/test` | Test SMTP connection |
| GET | `/api/settings/footer-links` | Get footer link configuration |
| PUT | `/api/settings/footer-links` | Update footer links |

---

## Health Check

```bash
curl http://localhost:4000/health
```

No authentication required.

---

[Back to README](../README.md) | [Tool Definition Format](tool-definition.md) | [Deployment Guide](deployment.md)

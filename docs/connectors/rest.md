# REST Connector — REST API to MCP

> Convert any REST API into MCP tools. Import from OpenAPI, Postman, cURL, or define tools manually.

[Back to README](../../README.md)

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

Optionally filter and transform API responses:

```json
{
  "responseMapping": {
    "type": "json",
    "fields": ["id", "name", "email", "status"]
  }
}
```

---

## Authentication

| Auth Type | Config |
|-----------|--------|
| **None** | `"authType": "NONE"` |
| **API Key** | `"authType": "API_KEY", "authConfig": {"key": "X-API-Key", "value": "your-key"}` |
| **Bearer Token** | `"authType": "BEARER_TOKEN", "authConfig": {"token": "your-token"}` |
| **Basic Auth** | `"authType": "BASIC_AUTH", "authConfig": {"username": "user", "password": "pass"}` |
| **OAuth2** | `"authType": "OAUTH2", "authConfig": {"tokenUrl": "...", "clientId": "...", "clientSecret": "...", "scope": "..."}` |

All credentials are encrypted with AES-256-GCM at rest.

OAuth2 supports automatic token refresh on 401 responses.

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

# GraphQL Connector — GraphQL to MCP

> Turn GraphQL APIs into MCP tools. Auto-generate tools from introspection queries.

[Back to README](../../README.md)

---

## Overview

The GraphQL connector exposes GraphQL queries and mutations as individual MCP tools. It supports automatic tool generation via introspection and manual query definition.

**Keywords:** GraphQL to MCP, GraphQL MCP bridge, GraphQL API to MCP server, GraphQL introspection MCP

---

## Creating a GraphQL Connector

### Via Web UI

1. Go to **Connectors** > **New Connector**
2. Select **GraphQL** as the type
3. Enter the **GraphQL Endpoint URL** (e.g., `https://api.example.com/graphql`)
4. Configure authentication if needed
5. Click **Create**

### Via API

```bash
curl -s http://localhost:4000/api/connectors \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "My GraphQL API",
    "type": "GRAPHQL",
    "baseUrl": "https://api.example.com/graphql",
    "authType": "BEARER_TOKEN",
    "authConfig": {
      "token": "your-graphql-token"
    }
  }'
```

---

## Importing Tools via Introspection

Provide the GraphQL endpoint and AnythingMCP will run an introspection query to auto-generate tools for each:
- **Query field** → Read-only tool
- **Mutation field** → Write tool

```bash
curl -s http://localhost:4000/api/connectors/$CONNECTOR_ID/import \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "source": "graphql",
    "url": "https://api.example.com/graphql"
  }'
```

Each generated tool includes:
- Typed parameters from the GraphQL schema
- The full query/mutation string
- Variable mapping

---

## Tool Configuration

### Endpoint Mapping for GraphQL

GraphQL tools use a specific mapping format:

```json
{
  "method": "query",
  "path": "query GetUser($id: ID!) { user(id: $id) { id name email } }",
  "queryParams": {
    "id": "$user_id"
  }
}
```

| Field | Description |
|-------|-------------|
| `method` | `query` or `mutation` |
| `path` | The GraphQL query/mutation string |
| `queryParams` | Maps tool parameters to GraphQL variables |
| `headers` | Optional HTTP headers for the request |

### Manual Tool Definition

```json
{
  "name": "search_products",
  "description": "Search products by name and category",
  "parameters": {
    "type": "object",
    "properties": {
      "query": { "type": "string", "description": "Search term" },
      "category": { "type": "string", "description": "Category filter" },
      "limit": { "type": "integer", "description": "Max results" }
    },
    "required": ["query"]
  },
  "endpointMapping": {
    "method": "query",
    "path": "query SearchProducts($query: String!, $category: String, $limit: Int) { searchProducts(query: $query, category: $category, limit: $limit) { id name price category } }",
    "queryParams": {
      "query": "$query",
      "category": "$category",
      "limit": "$limit"
    }
  }
}
```

---

## Authentication

GraphQL connectors support all standard auth types:

| Auth Type | Config |
|-----------|--------|
| **Bearer Token** | `"authType": "BEARER_TOKEN", "authConfig": {"token": "..."}` |
| **API Key** | `"authType": "API_KEY", "authConfig": {"key": "X-API-Key", "value": "..."}` |
| **Basic Auth** | `"authType": "BASIC_AUTH", "authConfig": {"username": "...", "password": "..."}` |
| **OAuth2** | `"authType": "OAUTH2", "authConfig": {"tokenUrl": "...", "clientId": "...", "clientSecret": "..."}` |

---

## Example: GitHub GraphQL API

```bash
# 1. Create connector
CONNECTOR_ID=$(curl -s http://localhost:4000/api/connectors \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "GitHub GraphQL",
    "type": "GRAPHQL",
    "baseUrl": "https://api.github.com/graphql",
    "authType": "BEARER_TOKEN",
    "authConfig": {"token": "ghp_your_github_token"}
  }' | jq -r '.id')

# 2. Create a tool manually
curl -s http://localhost:4000/api/connectors/$CONNECTOR_ID/tools \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "get_repo_info",
    "description": "Get GitHub repository information",
    "parameters": {
      "type": "object",
      "properties": {
        "owner": { "type": "string", "description": "Repository owner" },
        "name": { "type": "string", "description": "Repository name" }
      },
      "required": ["owner", "name"]
    },
    "endpointMapping": {
      "method": "query",
      "path": "query GetRepo($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { name description stargazerCount forkCount primaryLanguage { name } } }",
      "queryParams": {
        "owner": "$owner",
        "name": "$name"
      }
    }
  }'
```

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Introspection fails | Ensure the endpoint allows introspection queries and auth is configured |
| Variables not mapped | Verify `queryParams` keys match GraphQL variable names (case-sensitive) |
| Mutation not working | Set `"method": "mutation"` in the endpoint mapping |

---

[Back to README](../../README.md) | [Tool Definition Format](../tool-definition.md) | [API Reference](../api-reference.md)

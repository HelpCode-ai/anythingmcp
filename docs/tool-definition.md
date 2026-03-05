# Tool Definition Format

> How to define MCP tools in AnythingMCP: parameters, endpoint mapping, and response mapping.

[Back to README](../README.md)

---

## Overview

Every MCP tool in AnythingMCP is defined by three JSON objects:

1. **`parameters`** — What the AI can pass as input (JSON Schema)
2. **`endpointMapping`** — How parameters map to the API request
3. **`responseMapping`** — (Optional) How to transform the API response

---

## 1. Parameters (JSON Schema)

Standard JSON Schema that defines tool inputs visible to the AI:

```json
{
  "type": "object",
  "properties": {
    "user_id": { "type": "integer", "description": "The user's ID" },
    "include_details": { "type": "boolean", "description": "Include extra details" },
    "query": { "type": "string", "description": "Search query" }
  },
  "required": ["user_id"]
}
```

Supported types: `string`, `integer`, `number`, `boolean`, `array`, `object`

> **Tip:** Parameters matching environment variable names are automatically stripped from the tool schema, so the AI never sees them.

---

## 2. Endpoint Mapping

The bridge configuration that transforms MCP tool calls into API requests.

### REST Example

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

### Mapping Patterns

| Pattern | Location | Description |
|---------|----------|-------------|
| `{param}` in path | URL path | Replaced in URL: `/users/{id}` becomes `/users/123` |
| `"$param"` in queryParams | Query string | Added as `?param=value` |
| `"$param"` in bodyMapping | JSON body | Included in request body |
| `"$param"` in headers | HTTP headers | Sent as request header |

The `$` prefix means "take the value from the tool input parameter with this name."

### By Connector Type

| Connector | method | path | queryParams | bodyMapping | headers |
|-----------|--------|------|-------------|-------------|---------|
| **REST** | HTTP method (`GET`, `POST`, etc.) | URL path with `{param}` | Query string params | JSON body fields | HTTP headers |
| **GraphQL** | `query` or `mutation` | The GraphQL query string | GraphQL variables | — | HTTP headers |
| **SOAP** | SOAP operation name | Port/binding path | — | SOAP parameters | HTTP headers |
| **Database** | `query` or `static` | SQL/MongoDB query with `$param` | — | — | — |
| **MCP** | Remote tool name | — | — | Passed through | — |

### GraphQL Example

```json
{
  "method": "query",
  "path": "query GetUser($id: ID!) { user(id: $id) { id name email } }",
  "queryParams": {
    "id": "$user_id"
  }
}
```

### SOAP Example

```json
{
  "method": "GetCustomerDetails",
  "path": "CustomerServiceSoap12/BasicHttpBinding",
  "bodyMapping": {
    "customerId": "$customer_id",
    "includeHistory": "$include_history"
  }
}
```

### Database Example (SQL)

```json
{
  "method": "static",
  "path": "SELECT * FROM orders WHERE customer_id = $customer_id AND status = $status ORDER BY created_at DESC LIMIT $limit"
}
```

### Database Example (MongoDB)

```json
{
  "method": "query",
  "path": "db.collection('orders').find({customerId: $customer_id, status: $status}).sort({createdAt: -1}).limit($limit)"
}
```

### MCP Bridge Example

```json
{
  "method": "remote_tool_name",
  "bodyMapping": {
    "param1": "$param1",
    "param2": "$param2"
  }
}
```

---

## 3. Response Mapping (Optional)

Transform the API response before returning to the AI:

```json
{
  "type": "json",
  "fields": ["id", "name", "email", "status"]
}
```

This filters the response to only include the specified fields, reducing token usage and focusing the AI on relevant data.

---

## Full Tool Example

```json
{
  "name": "search_products",
  "description": "Search products by keyword and category",
  "parameters": {
    "type": "object",
    "properties": {
      "query": { "type": "string", "description": "Search keyword" },
      "category": { "type": "string", "description": "Product category" },
      "limit": { "type": "integer", "description": "Max results (default 10)" }
    },
    "required": ["query"]
  },
  "endpointMapping": {
    "method": "GET",
    "path": "/api/products/search",
    "queryParams": {
      "q": "$query",
      "cat": "$category",
      "limit": "$limit"
    }
  },
  "responseMapping": {
    "type": "json",
    "fields": ["id", "name", "price", "category"]
  }
}
```

---

[Back to README](../README.md) | [API Reference](api-reference.md) | [REST Connector](connectors/rest.md)

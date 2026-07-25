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

For generic tools that take the GraphQL operation **as input**, set `path` to a `$paramName` reference and use `variablesFromParam` to forward the variables map verbatim:

```json
{
  "method": "query",
  "path": "$query",
  "variablesFromParam": "variables"
}
```

The GraphQL engine also supports `"method": "static"`, which returns `path` verbatim with no HTTP call — useful for tools that just need to expose a fixed value (e.g. the URL of the SDL schema).

#### GraphQL builtin tools (auto-injected)

Every adapter with `connector.type === "GRAPHQL"` is automatically extended with four generic tools:

- `<slug>_graphql_schema_url` — returns the URL of the SDL schema (default `${baseUrl}/schema`, override via `connector.schemaUrl`)
- `<slug>_graphql_query` — execute an arbitrary `query`
- `<slug>_graphql_mutation` — execute an arbitrary `mutation`
- `<slug>_graphql_subscription` — execute an arbitrary `subscription` (transport availability depends on the upstream API)

Adapter authors don't need to declare them.

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

## 4. Tool Annotations (Optional)

Annotations are the [MCP spec's](https://modelcontextprotocol.io/specification) advisory hints that let an
agent reason about a tool *before* calling it — above all whether it can change anything. An agent that
knows a tool is read-only will probe it freely instead of asking for confirmation.

| Hint | Spec default | Meaning |
|---|---|---|
| `title` | — | Human-readable title for display |
| `readOnlyHint` | `false` | The tool does not modify its environment |
| `destructiveHint` | `true` | The write removes/overwrites rather than only adding. Meaningful only when `readOnlyHint` is false |
| `idempotentHint` | `false` | Repeating the call with the same arguments changes nothing further. Meaningful only when `readOnlyHint` is false |
| `openWorldHint` | `true` | Interacts with an external system of unbounded scope |

> Annotations are hints, not access control. The spec states clients must never make trust decisions based
> on them. Real enforcement stays in roles and per-tool access.

### Derived automatically

You normally do not set these. AnythingMCP derives them from what the connector already declares:

| Connector | Signal | Result |
|---|---|---|
| REST | `GET` / `HEAD` / `OPTIONS` | `readOnlyHint: true` |
| REST | `POST` | write, additive, non-idempotent |
| REST | `PUT` / `DELETE` | write, destructive, idempotent |
| REST | `PATCH` | write, destructive, non-idempotent |
| GraphQL | `query` / `mutation` | read-only / write |
| Database | connector `readOnly` flag, or `SELECT` vs `INSERT`/`UPDATE`/`DELETE` in the statement | read-only / write; always `openWorldHint: false` |
| Database | `static` method | read-only |
| SOAP | operation name only | never asserts read-only; flags a clearly-named destructive op |
| MCP bridge | the upstream server's own annotations | passed through verbatim |

An unambiguous tool name (`delete_…`, `create_…`) refines `destructiveHint`, but **name heuristics never
assert `readOnlyHint`**: wrongly claiming read-only would invite an agent to call a mutating tool freely,
whereas omitting the hint only makes it more careful.

### Overriding

The one case the derivation cannot solve is a **read-only endpoint exposed over `POST`** — very common for
search APIs, and indistinguishable from a write at the protocol level. Fix it per tool, in the UI via the
tool's **Hints** button, or over the API:

```bash
# Mark a POST-based search as read-only
curl -X PATCH .../api/connectors/<connectorId>/tools/<toolId>/annotations \
  -H 'Authorization: Bearer <token>' -H 'Content-Type: application/json' \
  -d '{"annotations": {"readOnlyHint": true}}'

# Inspect derived vs override vs effective
curl .../api/connectors/<connectorId>/tools/<toolId>/annotations -H 'Authorization: Bearer <token>'

# Drop the override, go back to derived
curl -X PATCH .../api/connectors/<connectorId>/tools/<toolId>/annotations \
  -H 'Authorization: Bearer <token>' -H 'Content-Type: application/json' \
  -d '{"annotations": null}'
```

An override survives a re-import. Annotations coming from an *upstream MCP server* are refreshed on
re-import, since that server is authoritative about its own tools.

---

## 5. Caller-Context Variables (`{{amcp.*}}`)

Connectors often front a **service**-based API while users authenticate to AnythingMCP individually (OAuth,
per-user MCP API keys). The target system then only ever sees the service identity and cannot record who
actually asked. These reserved variables forward the calling identity so it can — in headers, query
parameters, the body, or the path:

```json
{
  "method": "POST",
  "path": "/tickets",
  "headers": {
    "X-Requested-By": "{{amcp.user_email}}"
  },
  "bodyMapping": {
    "subject": "$subject",
    "requestedBy": "{{amcp.user_email}}"
  }
}
```

| Variable | Value |
|---|---|
| `{{amcp.user_email}}` | E-mail of the calling user |
| `{{amcp.user_id}}` | Internal user id |
| `{{amcp.org_id}}` | Workspace (organization) id |
| `{{amcp.server_id}}` | Id of the MCP server that exposed the tool |
| `{{amcp.server_name}}` | Name of that MCP server |
| `{{amcp.auth_method}}` | `jwt`, `mcp_api_key`, `static_api_key`, `static_bearer` or `none` |
| `{{amcp.api_key_name}}` | Name of the MCP API key used, when applicable |

Behaviour worth knowing:

- **Opt-in.** Nothing is forwarded unless you write the variable somewhere. Identity is personal data, so it
  is never attached automatically.
- **Not always available.** Identity exists for OAuth and per-user MCP API keys. With an instance-wide static
  API key or bearer token, and in anonymous mode, there is no user — the variable resolves to an **empty
  string** rather than leaking a literal `{{amcp.…}}` to the target.
- **Non-spoofable.** The values are resolved server-side from the authenticated request and merged *after*
  connector env vars, so neither a workspace variable nor a tool argument can shadow them.
- **Typos are rejected** when you save the tool, since at runtime an unknown reserved variable would silently
  resolve to empty.
- These variables apply to `baseUrl`, connector headers and the endpoint mapping. They are **not** substituted
  inside `authConfig`.

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

## Authentication: `LOGIN_TOKEN`

In addition to the standard `NONE` / `API_KEY` / `BEARER_TOKEN` / `BASIC_AUTH` / `OAUTH2` / `QUERY_AUTH` / `WS_SECURITY` / `CERTIFICATE` / `CONNECTION_STRING` schemes, the connector spec supports `LOGIN_TOKEN` for APIs that issue a long-lived bearer **in exchange for a credentials POST** — optionally requiring the password to be **bcrypt-hashed with a salt fetched from the remote service** (Sorare-style).

The engine handles salt fetch → bcrypt → login → token cache → proactive refresh → re-login-on-401 automatically. Adapter authors declare the full flow as JSON:

```json
{
  "authType": "LOGIN_TOKEN",
  "authConfig": {
    "loginUrl": "https://api.example.com/graphql",
    "loginMethod": "POST",
    "loginBody": {
      "query": "mutation Login($email: String!, $password: String!) { signIn(input: {email: $email, password: $password}) { jwtToken { token expiredAt } } }",
      "variables": { "email": "${username}", "password": "${passwordHashed}" }
    },
    "username": "{{SERVICE_EMAIL}}",
    "password": "{{SERVICE_PASSWORD}}",
    "aud": "{{SERVICE_AUD}}",
    "passwordHashing": {
      "scheme": "bcrypt",
      "saltSource": {
        "type": "fetch",
        "method": "GET",
        "url": "https://api.example.com/api/v1/users/${username}",
        "responsePath": "salt"
      },
      "outputParam": "passwordHashed"
    },
    "tokenJsonPath": "data.signIn.jwtToken.token",
    "expiryJsonPath": "data.signIn.jwtToken.expiredAt",
    "expiryFormat": "iso8601",
    "tokenTTLSeconds": 2592000,
    "refreshOn401": true,
    "proactiveRefreshSeconds": 86400,
    "headerName": "Authorization",
    "headerTemplate": "Bearer ${token}",
    "extraHeaders": { "JWT-AUD": "${aud}" }
  }
}
```

See [`docs/connectors/login-token-auth.md`](connectors/login-token-auth.md) for the full field-by-field reference, salt-source types (`fetch` vs `static`), expiry formats (`iso8601` / `unix` / `ttl_seconds`), and re-login policies.

---

[Back to README](../README.md) | [API Reference](api-reference.md) | [REST Connector](connectors/rest.md) | [LOGIN_TOKEN reference](connectors/login-token-auth.md)

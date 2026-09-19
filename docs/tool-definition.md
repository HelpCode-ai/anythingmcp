# Tool Definition Format

> How to define MCP tools in AnythingMCP: parameters, endpoint mapping, and response mapping.

[Back to README](../README.md)

---

## Overview

Every MCP tool in AnythingMCP is defined by three JSON objects:

1. **`parameters`** — What the AI can pass as input (JSON Schema)
2. **`endpointMapping`** — How parameters map to the API request
3. **`responseMapping`** — (Optional) How to transform the API response

## Adapter envelope

The catalog validator requires each adapter to provide `slug`, `name`,
`description`, `region`, `category`, `icon`, `docsUrl`, `requiredEnvVars`,
`connector`, and a non-empty `tools` array. The filename must match `slug`.
Optional environment variables use the same array-of-strings shape and must
not duplicate a required variable.

### Adapter fields

Keep the required envelope fields above at the adapter root; use arrays for
`requiredEnvVars` and `optionalEnvVars`, and do not list one variable in both.

### Tools

Each entry in `tools` needs a string `name`, a useful `description`, and its
JSON-Schema `parameters` when it accepts input. Parameter properties should
include descriptions for the model.

See [connector configuration](#connector)
and [authentication](#authentication) for the nested connector fields.

### Connector

Set `connector.type` to `REST`, `GRAPHQL`, `SOAP`, `MCP`, `DATABASE`, or
`LOGIN_TOKEN`. Set `connector.authType` to a supported authentication scheme
listed below; these values are validated before an adapter can pass.

### Authentication

Use `NONE`, `API_KEY`, `BEARER_TOKEN`, `BASIC`, `BASIC_AUTH`, `OAUTH2`,
`OAUTH1`, `LOGIN_TOKEN`, `QUERY_AUTH`, `CONNECTION_STRING` or `HMAC` as
`connector.authType`. Keep the corresponding credentials in `authConfig` and
reference environment variables with `{{VAR}}` where the connector injects
them.

### HMAC-signed requests

Some APIs never receive the secret: each request carries a digest computed
over a canonical string. `authType: "HMAC"` describes that string in the
adapter rather than in per-vendor engine code. Signing happens after the body
and query are built, because the canonical string usually folds them in.

```json
"authType": "HMAC",
"authConfig": {
  "signature": {
    "algorithm": "sha256",
    "encoding": "hex",
    "secret": "{{KAUFLAND_SECRET_KEY}}",
    "template": "${method}\n${url}\n${body}\n${timestamp}\n",
    "headerName": "Shop-Signature",
    "timestampHeader": "Shop-Timestamp",
    "extraHeaders": { "Shop-Client-Key": "{{KAUFLAND_CLIENT_KEY}}" }
  }
}
```

`template` may use `${method}`, `${url}`, `${path}` (path + query only),
`${body}` and `${timestamp}` (Unix seconds), in whatever order the vendor
documents. `\n` is honoured. `algorithm` is `sha256` (default), `sha1` or
`sha512`; `encoding` is `hex` (default) or `base64`. `timestampHeader` sends
the same timestamp that went into the string, which the server needs to
recompute it.

The body is signed exactly as it will be sent — signing a different rendering
of the same object is the usual way an HMAC integration fails with an error
that blames the key.

### DATABASE adapters

A `DATABASE` adapter points at a database instead of an HTTP API, so several
of the REST rules simply do not apply to it:

- `authType` is `CONNECTION_STRING`. `baseUrl` is the DSN and carries the
  driver (`postgres://`, `mysql://`, `mariadb://`, `mssql://`, `oracle://`,
  `mongodb://`, `sqlite://`) — the engine picks the driver from that prefix.
- Put the username and password in `authConfig`, not in the DSN. `authConfig`
  is encrypted at rest; `baseUrl` is not. The engine splices them into the URL
  (Postgres, MySQL, Mongo) or passes them as driver config (MSSQL, Oracle,
  which also accept `authConfig.domain` for NTLM).
- `endpointMapping.method` is `query`, `static`, or `mongo_schema` — never an
  HTTP verb. `path` is the statement, not a URL.
- A `path` of exactly `${query}` hands the engine the caller's raw SQL. Any
  other `path` is a template whose `${name}` placeholders are compiled to
  bound parameters, never string-interpolated.
- Adapters install **read-only**; the engine rejects anything but a read until
  the user flips the switch in the connector's settings.
- Declare a `probe` (a listing tool with no required parameters). A DATABASE
  adapter has no HTTP healthcheck, so without one the install reports nothing.

```json
{
  "slug": "postgres",
  "requiredEnvVars": ["POSTGRES_HOST", "POSTGRES_PORT", "POSTGRES_DATABASE", "POSTGRES_USER", "POSTGRES_PASSWORD"],
  "probe": { "tool": "postgres_list_tables" },
  "connector": {
    "name": "PostgreSQL",
    "type": "DATABASE",
    "authType": "CONNECTION_STRING",
    "baseUrl": "postgres://{{POSTGRES_HOST}}:{{POSTGRES_PORT}}/{{POSTGRES_DATABASE}}",
    "authConfig": {
      "username": "{{POSTGRES_USER}}",
      "password": "{{POSTGRES_PASSWORD}}"
    }
  },
  "tools": [
    {
      "name": "postgres_query",
      "description": "Run a read-only SQL SELECT against the database and return up to 1000 rows.",
      "parameters": {
        "type": "object",
        "properties": { "query": { "type": "string", "description": "A single SQL SELECT statement." } },
        "required": ["query"]
      },
      "endpointMapping": { "method": "query", "path": "${query}" }
    }
  ]
}
```

### Adapter file errors

If an adapter file cannot be read, check that its path exists and that the
validator process has permission to read it. This is distinct from invalid JSON
syntax, which requires fixing the file contents.

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

### Response headers and pagination (`exposeHeaders`)

By default a tool receives the response **body** and nothing else. Some APIs put
the one thing a model needs to continue in a header instead: GitHub, GitLab,
Sentry and Shopify paginate with `Link: <...?cursor=xyz>; rel="next"`, and most
APIs report rate limits in `X-RateLimit-*`. Without those, every list tool is
exactly one page long.

A REST tool can opt in per header name (case-insensitive):

```json
{
  "method": "GET",
  "path": "/organizations/{{SENTRY_ORG}}/issues/",
  "queryParams": { "cursor": "$cursor", "query": "$query" },
  "exposeHeaders": ["link", "x-ratelimit-remaining"]
}
```

The selected headers are added to the tool result next to the body, and a
`Link` header with `rel="next"` is parsed for you:

```json
{
  "...the body as before...": "",
  "_headers": { "link": "<https://sentry.io/api/0/...?cursor=1568:0:0>; rel=\"next\"", "x-ratelimit-remaining": "39" },
  "_pagination": { "nextUrl": "https://sentry.io/api/0/...?cursor=1568:0:0", "nextCursor": "1568:0:0", "cursorParam": "cursor" }
}
```

- `_pagination` is **absent on the last page**; tell the model so in the tool description ("call again with `cursor` = `_pagination.nextCursor` until it is missing").
- `nextCursor` is recognised for the usual parameter names (`cursor`, `page`, `offset`, `after`, `page_token`, `starting_after`, ...); otherwise only `nextUrl` is set.
- If the body is not a JSON object (an array, a string) it is wrapped as `data` so the extras have somewhere to live.
- A response transform (`responseMapping.transform`) runs on the body first; the extras are attached afterwards, so a `select` cannot drop them.
- The audit log keeps storing the bare body. Headers are cached together with it when `cacheTtl` is set.
- REST connectors only. Tools that did not set `exposeHeaders` behave exactly as before.

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

`${name}` placeholders are compiled to the driver's bound parameters
(`$1`, `?`, `:1`), so values are never spliced into the statement.

```json
{
  "method": "query",
  "path": "SELECT * FROM orders WHERE customer_id = ${customer_id} AND status = ${status} ORDER BY created_at DESC LIMIT ${limit}"
}
```

### Database Example (MongoDB)

The path is a JSON find spec — `collection` plus optional `filter`,
`projection`, `sort` and `limit`. `mongo_schema` takes no path at all and
lists the collections with a sampled field list.

```json
{
  "method": "query",
  "path": "{\"collection\": \"orders\", \"filter\": {\"customerId\": \"${customer_id}\"}, \"sort\": {\"createdAt\": -1}, \"limit\": ${limit}}"
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

`path` is optional here: omit it and the call goes to the connector's base URL
(or `<host>/mcp` if the base URL has no path). Set it only to send this one tool
somewhere else — see [MCP Bridge](connectors/mcp-bridge.md).

---

## 3. Response Mapping (Optional)

Shapes the API response **before it reaches the AI client**. Two reasons to use
it: keeping fields that should never travel out of the model's context, and not
paying for upstream noise in the context window.

The mapping is applied on the way out, so anything you drop never reaches the
agent or the model provider behind it. Your audit log still records the full
upstream response, so shaping the answer does not cost you the evidence of what
the API actually returned.

```json
{
  "transform": {
    "mode": "select",
    "exclude": ["customer.iban", "customer.taxId"],
    "select": { "order": "$.id", "total": "$.amounts.gross", "status": "$.state" }
  },
  "cacheTtl": 3600
}
```

| Field | Description |
|-------|-------------|
| `mode` | `select` (declarative template), `jmespath` (evaluate `expression`), or `off` to keep the config without applying it |
| `exclude` | Paths to drop, applied before everything else. The lever for PII and secrets |
| `include` | Keep only these paths, preserving the original document shape |
| `select` | Output template: keys are output names, leaves are paths (`$.a.b[*].c`) or literals |
| `expression` | JMESPath expression, for reshaping a template cannot express |
| `fallbackToRaw` | On error, return the raw response instead of failing. Default `true` |
| `maxBytes` | Hard cap on the serialized output. `0` or absent means no cap |
| `cacheTtl` | Seconds to cache the **raw** upstream response; shaping happens on read |

### `select` leaf syntax

| Leaf | Result |
|------|--------|
| `"$.a.b"` / `"a.b"` | Path lookup. The key is omitted when the path is not found |
| `"= [redacted]"` | The static string `[redacted]`. Leading `=` marks a literal, so a constant is not mistaken for a path |
| `42`, `true`, `null` | Passed through as-is |
| `{ "$from": "$.rows[*]", "$select": { … } }` | Iterate an array and reshape every element |
| `{ … }` / `[ … ]` | Nested template / array of the above |

Paths accept `$.a.b`, `a[0].b`, `a[*].b` and `a['weird.key']`. A leading `$.` is
optional. Depth, path count and output size are bounded, so a pathological
response or template cannot pin a worker.

**Masking rather than dropping.** `exclude` removes a field outright, which
changes the shape of the response. When an agent is better served by a stable
shape, replace the value instead:

```json
{ "transform": { "mode": "select", "select": {
  "order": "$.id",
  "customer": "$.customer.name",
  "iban": "= [redacted]"
} } }
```

**In the UI:** the tool editor has a Response Mapping panel with the same three
modes and a **live preview** that runs the mapping against a real response and
reports the before/after size. A tool with a broken mapping is flagged in the
tool list rather than failing silently.

> A tool without a mapping behaves exactly as before — same object, byte for
> byte. The no-op path is the one that must never regress.

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
| REST | `GET` / `HEAD` / `OPTIONS` | read-only |
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

Once the read/write verdict is known, all three of `readOnlyHint`, `destructiveHint` and `idempotentHint`
are emitted explicitly. A read-only tool gets `destructiveHint: false` and `idempotentHint: true`; a write
with nothing better known gets the spec defaults. Some directory reviewers (OpenAI's plugin portal, for
one) reject a tool whose `destructiveHint` is missing, even a read-only one, so nothing is left implicit.

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
- These variables apply to `baseUrl`, connector headers and the whole endpoint mapping — `path`,
  `queryParams`, `bodyMapping` **and `bodyTemplate`**. In a `bodyTemplate` the substituted value is escaped
  for its JSON string context, so a quote or backslash cannot break the document. They are **not**
  substituted inside `authConfig`.
- The **Test** button in the connector UI does not run through an authenticated MCP session, so `{{amcp.*}}`
  resolves to empty there; the test result says so. Call the tool from a connected MCP client to see the
  real value.

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
    "transform": {
      "select": {
        "total": "$.meta.totalCount",
        "products": {
          "$from": "$.data[*]",
          "$select": {
            "id": "id",
            "name": "attributes.name",
            "price": "attributes.price.amount",
            "category": "relationships.category.name"
          }
        }
      }
    }
  }
}
```

`responseMapping.transform` shapes the response before it reaches the AI client —
fewer tokens, and only the fields this tool needs leave the workspace. It is
optional: without it the raw upstream response is returned unchanged. See
[REST connector → Response Mapping](connectors/rest.md#response-mapping) for the
full syntax (`select`, `include`, `exclude`, JMESPath, `maxBytes`) — it applies
to every connector type, not just REST.

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

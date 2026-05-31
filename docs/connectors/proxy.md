# Proxy / Web-Unblocker

Some upstream APIs block server-side requests — by IP reputation, geo, rate
limits, or full anti-bot systems (Akamai Bot Manager, Cloudflare, DataDome).
AnythingMCP can route a tool's outbound HTTP request through a proxy or a
**web unblocker** so those connectors work from your server.

## How it turns on

Three things must line up for a request to be proxied:

1. **`CONNECTOR_PROXY_URL` is set** on the instance (env). If it isn't, the
   feature is off everywhere — a tool that opted in just makes a direct
   request (no error).
2. **The tool opted in** — `mcp_tools.use_proxy = true`. This is seeded from
   the adapter spec's per-tool `useProxy` (default `false`) and can be toggled
   per tool in the connector UI (the checkbox only appears when
   `CONNECTOR_PROXY_URL` is set).
3. **(Cloud only)** the workspace has an active license/trial and is under its
   hourly proxy cap (see below). Self-hosted installs have no license gate and
   no rate limit.

If all three hold, the request goes through the proxy. Otherwise it goes out
directly.

## Configuring the proxy

```bash
# Zyte API "proxy mode" — defeats Akamai/Cloudflare/DataDome (recommended for
# anti-bot targets). The API key is the proxy username, empty password.
CONNECTOR_PROXY_URL=http://<ZYTE_API_KEY>:@api.zyte.com:8011

# …or any rotating/residential proxy for IP/geo/rate-limit cases:
CONNECTOR_PROXY_URL=http://user:pass@host:port
```

The credential lives only in this env var. It is never exposed to the
frontend (the UI only learns a boolean "available") and never logged.

Implementation note: the engine attaches an `HttpsProxyAgent` with
`rejectUnauthorized: false`, which is required for unblockers like Zyte that
intercept TLS.

## Rate limit (cloud)

Each workspace is capped at **`PROXY_RATE_LIMIT_DEFAULT`** proxy-routed tool
calls per hour (default **100**). Over the cap, a proxied tool call returns an
explicit error:

> Proxy quota exceeded: this workspace is limited to N proxy/unblocker tool
> calls per hour. Try again in ~M minute(s), or run this tool without the proxy.

Only requests that actually use the proxy count toward the cap; direct
requests don't.

To raise or lower a single workspace's cap, a **service admin** sets
`organizations.proxy_rate_limit` directly in the database — there is
intentionally **no API** to change it:

```sql
UPDATE organizations SET proxy_rate_limit = 500 WHERE id = '<org_id>';
-- NULL → fall back to PROXY_RATE_LIMIT_DEFAULT (or 100 if that is unset)
```

## Adapter authoring

Set `useProxy: true` on a tool in the adapter JSON to recommend proxy routing
by default. Use it for anti-bot, geo-restricted, reverse-engineered, or
rate-limited APIs. Default is `false`.

```jsonc
{
  "name": "db_get_departures",
  "description": "…",
  "useProxy": true,
  "endpointMapping": { "method": "GET", "path": "/reiseloesung/abfahrten" }
}
```

Adapters shipped with `useProxy: true` today: Deutsche Bahn, Playtomic
(+ public), Sorare, OpenTable, Resy, Vinted, Untappd, idealista, Trenitalia,
ImmobilienScout24, Etsy, Mercado Libre.

For GraphQL adapters, if any tool opts in, the auto-injected
`<slug>_graphql_query` / `_mutation` / `_subscription` helpers inherit the
proxy preference too.

## Scope

Proxy routing is applied by the **REST** and **GraphQL** engines. SOAP,
Database, and MCP-bridge connectors ignore the flag.

# OData to MCP

AnythingMCP connects Claude, ChatGPT and Copilot to OData V2 and V4 services through MCP, with SAP Gateway (S/4HANA, ECC, BW) as a first-class case. An OData connector reads each service's `$metadata`, so the model sees entity sets, keys and fields with their business labels, the currency or unit that belongs to each amount, and which fields are dimensions or measures, before it asks for a single row.

[Back to README](../../README.md) · [REST connector](rest.md) · [SAP HANA](sap-hana.md)

---

## Two ways to get it

- **OData connector type.** Pick *OData* when creating a connector. Choose *SAP Gateway* for an SAP system (the base URL is the host, e.g. `https://s4.example.com:44300`, services come from SAP's catalog), or leave it off for a single OData service (the base URL is the service root, e.g. `https://services.example.com/odata/v4/Sales`).
- **A REST connector with OData settings.** A REST connector whose `config.odata` is set gets the same built-in tools; its own tools stay plain REST calls. The SAP S/4HANA Cloud catalog adapter works this way.

Both use the REST engine underneath, so every REST authentication method applies (Basic, OAuth 2.0 client credentials or authorization code, API key, certificates, login token), as do retries, the outbound SSRF guard and the proxy.

## Built-in tools

Every OData connector carries five tools, named `<prefix>_…` (the prefix is the connector name plus `_odata`, or `config.odata.toolPrefix`):

| Tool | What it does |
|------|--------------|
| `<prefix>_list_services` | SAP: searches the Gateway service catalog, V2 (`/IWFND/CATALOGSERVICE`) and V4 (service groups), cached for an hour. Otherwise: the services listed in the connector's settings, or the single service root. |
| `<prefix>_describe_service` | Entity sets with their labels, keys, number of fields, and flags: *analytical* (the server aggregates), *parameters* (parameterised view), *requiredInFilter*, *readOnly*. `$metadata` is cached for 24 hours; `refresh: true` reloads it. |
| `<prefix>_describe_entity` | Every field with label, type, key, the currency/unit field (`sap:unit`, `Measures.ISOCurrency`), the text field (`sap:text`, `Common.Text`), filterable/sortable and dimension/measure role; navigation properties; hints for analytical and parameterised sets. |
| `<prefix>_query` | `select`, `filter`, `orderby`, `top` (≤ 1000), `skip`, `expand`, `parameters`, V4 `apply` and `search`. Field names are checked against the model first ("Unknown field … Did you mean …"), required filters are enforced, server paging is followed on the connector's own host only, and the answer is flattened: plain rows, dates as ISO strings, decimals as strings, total count and `nextSkip`. |
| `<prefix>_get_entity` | One entity by key; a composite key as `{"SalesOrder": "1", "SalesOrderItem": "10"}`. |

The built-ins only read, and are annotated read-only for MCP clients.

## Settings (`config.odata`)

| Key | Meaning |
|-----|---------|
| `sap` | SAP Gateway mode: catalog discovery, SAP parameters. Implied by `sapClient`. |
| `sapClient` | Three-digit SAP client, sent as `sap-client` on every request. |
| `sapLanguage` | Sent as `sap-language`, e.g. `EN`. |
| `services` | Allowed service paths, `*` as wildcard. Other services are refused. Without wildcards, the list is also what `list_services` returns on a non-SAP connector. |
| `version` | `v2` or `v4` to override detection from `$metadata`. |
| `maxRows` | Row cap per query, at most 1000. |
| `toolPrefix` | Prefix of the built-in tool names. |

All of them can hold `{{VARIABLES}}`, resolved from the connector's environment variables at call time. They are edited under the connector's settings.

## Importing tools from `$metadata`

**Import Tools → OData $metadata** turns a service's entity sets into named tools: `<set>_list` (with filter, select, orderby, top, skip, expand) and `<set>_get` (key parameters). Give the service path (SAP) or leave it empty (single service); the document is fetched with the connector's credentials. You can also paste a `$metadata` document and limit the import to some entity sets. Re-importing a service updates its tools and retires only that service's tools that disappeared, never the built-ins or another service's tools.

On an OData connector, imported and hand-written HTTP tools get the SAP client and language, JSON format for V2 and flattened answers. SAP writes (POST, PUT, PATCH, DELETE) fetch a CSRF token with the session cookies first.

## SAP Gateway setup

1. A technical user of type *System*, with a productive password, in the client you want to read.
2. A role with `S_SERVICE` for the services the agent may call, and display-only business authorizations. For catalog browsing, also the V2 catalog service `/IWFND/CATALOGSERVICE` and the V4 catalog. SAP checks these authorizations on every call; they are the real boundary.
3. Active services (`/IWFND/MAINT_SERVICE`, `/IWFND/V4_ADMIN`).
4. Network: the Gateway port is usually internal. Self-host AnythingMCP inside the network or reach it through a VPN, and add the host to `SSRF_ALLOWED_HOSTS`.

SAP's API policy expects third-party integrations to use published APIs (`API_*` services on the SAP Business Accelerator Hub) or services the customer built; restrict `services` accordingly.

The **SAP S/4HANA (OData)** catalog adapter packages all of this for on-premise and Private Cloud systems: the built-ins with the `s4` prefix, ready tools for journal entry items, billing documents, sales orders, business partners, material stock and products, and a guide (`s4_guide`) to filters, analytical services and KPIs.

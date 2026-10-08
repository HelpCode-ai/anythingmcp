# SOAP / WSDL to MCP

AnythingMCP turns a SOAP web service into MCP tools for Claude, ChatGPT and Copilot without code. Give it the WSDL and each operation becomes a tool; AnythingMCP builds the SOAP envelope, keeps the WSDL parameter order that WCF services need and authenticates with HTTP Basic, a bearer token, an API-key header or a WS-Security UsernameToken, so AI agents can call legacy enterprise SOAP APIs.

[Back to README](../../README.md)

---

## Overview

The SOAP connector lets you expose SOAP web services as MCP tools. It parses WSDL definitions, auto-generates tools for each operation, and handles SOAP envelope construction and parameter ordering.

**Keywords:** SOAP to MCP, WSDL to MCP, SOAP MCP bridge, enterprise API to MCP, WCF to MCP, legacy API integration MCP

---

## Creating a SOAP Connector

### Via Web UI

1. Go to **Connectors** > **New Connector**
2. Select **SOAP** as the type
3. Enter the **WSDL URL** (e.g., `https://service.example.com/api?wsdl`)
4. Configure authentication if needed
5. Click **Create**

### Via API

```bash
curl -s http://localhost:4000/api/connectors \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Enterprise CRM",
    "type": "SOAP",
    "baseUrl": "https://crm.example.com/service",
    "specUrl": "https://crm.example.com/service?wsdl",
    "authType": "BASIC_AUTH",
    "authConfig": {
      "username": "api-user",
      "password": "api-pass"
    }
  }'
```

### Testing the connection

**Test connection** (and the dashboard's health check) reads the connector's WSDL the way an import does: from `specUrl` or, without one, from the base URL and, when that is not a WSDL and has no query string, from the base URL with `?wsdl` (WCF and JAX-WS serve it there). It calls no operation, since any of them may change data, so it does not check the credentials (HTTP Basic, bearer token, API key or WS-Security): run a read-only tool from the connector page for that. A WSDL read in the last ten minutes is not downloaded again.

| Result | Status |
|--------|--------|
| The WSDL is read | OK, with the number of operations and ports |
| The service answers below HTTP 500 but no WSDL can be read there (an HTML page, 404, 405, ...) | OK: tools that already have their metadata work without a WSDL. The message suggests setting the WSDL URL, which an import or a refresh needs |
| The service answers 401 or 403 | OK, with a note: the WSDL is downloaded without the connector's credentials, so a WSDL behind authentication cannot be read |
| DNS, connection, timeout or TLS failure, a host blocked by the SSRF guard, or HTTP 500 and above | Failed |

---

## Importing Tools from WSDL

Provide the WSDL URL and AnythingMCP will:
1. Fetch and parse the WSDL definition
2. Extract all SOAP operations
3. Generate an MCP tool for each operation with proper parameters

```bash
curl -s http://localhost:4000/api/connectors/$CONNECTOR_ID/import \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "source": "wsdl",
    "url": "https://crm.example.com/service?wsdl"
  }'
```

### Endpoint Mapping for SOAP

SOAP tools use a specific endpoint mapping format:

```json
{
  "method": "GetCustomerDetails",
  "path": "CustomerServiceSoap12/BasicHttpBinding_ICustomerService",
  "bodyMapping": {
    "customerId": "$customer_id",
    "includeOrders": "$include_orders"
  }
}
```

| Field | Description |
|-------|-------------|
| `method` | SOAP operation name |
| `path` | SOAP port/binding path |
| `bodyMapping` | Maps tool params to SOAP envelope parameters |
| `inputElement` | Body element that wraps the parameters, when the WSDL's input element is not named after the operation (set on import) |
| `inputNamespace` | Namespace of that element, when it differs from the WSDL `targetNamespace` (set on import) |
| `childElementsQualified` | `false` when the parameter elements carry no namespace: RPC style, or a schema with `elementFormDefault="unqualified"` (the XSD default, common in JAX-WS services) or `form="unqualified"`. The engine then writes `<customerId>` instead of `<tns:customerId>` (set on import; absent: qualified, as WCF needs) |
| `soapVersion` | `"1.2"` for an operation of a SOAP 1.2 port (set on import; absent: SOAP 1.1) |
| `elementOrder` | Order of the child elements of complex parameters, by path (`{"address": ["street", "city"]}`), because the schema's `xs:sequence` is order-sensitive and a stored tool does not keep the key order of objects (set on import) |

### Parameter values

Each parameter becomes an element in the body. Values are written as follows:

| Value | XML |
|-------|-----|
| Text, number, boolean | The element with the value as text, escaped |
| Object | The element with one child element per field, in the order the schema declares them (`elementOrder`); fields the schema does not list follow in the order sent |
| List | The element repeated once per item, for elements with `maxOccurs` above 1 (imported as array parameters) |
| `null` or missing | Left out |

Values may nest up to 20 levels; field names must be valid XML names. Attributes and `xsi:type` are not written.

### Required and optional parameters

On import, a parameter is required only when its schema element has no `minOccurs` or `minOccurs` of at least 1, and is not one branch of an `xs:choice`. WCF marks nearly every element `minOccurs="0"`, so its parameters are optional and the AI client no longer has to invent values for them; `nillable` alone does not make an element optional. RPC parts, and every parameter of an operation whose schema cannot be resolved, stay required. `xs:enumeration` values become the parameter's `enum`, and `xs:dateTime`, `xs:date` and `xs:time` parameters get the JSON Schema format `date-time`, `date` and `time`. Tools imported earlier keep the parameters they were stored with: re-import the WSDL to update them.

---

## WCF Service Support

AnythingMCP handles WCF-specific requirements:

- **Parameter ordering** — WSDL-defined parameter order is preserved (WCF services are order-sensitive)
- **Endpoint override** — The connector's `baseUrl` overrides the WSDL endpoint host, useful for internal networks where the WSDL advertises external IPs
- **Multiple bindings** — Each port/binding generates separate tools. An operation that a service offers on both a SOAP 1.1 and a SOAP 1.2 port (WCF's `BasicHttpBinding` next to a SOAP 1.2 binding) becomes one tool, on the SOAP 1.1 port, because tools are named after the service and the operation
- **SOAPAction header** — Sent with the operation's `soapAction` from the WSDL; when the WSDL declares an empty action, the header is sent as `SOAPAction: ""`, as SOAP 1.1 requires

### SOAP 1.2

Operations of a SOAP 1.2 port (a binding with a `soap12:binding` element, namespace `http://schemas.xmlsoap.org/wsdl/soap12/`) are imported with `"soapVersion": "1.2"` and sent as SOAP 1.2: the envelope uses the `http://www.w3.org/2003/05/soap-envelope` namespace, and the action travels in the media type, `Content-Type: application/soap+xml; charset=utf-8; action="<soapAction>"` (without `action` when the WSDL declares none), instead of a `SOAPAction` header. SOAP 1.2 faults are read from `Reason/Text`.

WCF bindings that also require WS-Addressing headers (`wsHttpBinding`, a `wsaw:UsingAddressing` policy) are not supported: use the service's `BasicHttpBinding` port.

---

## Authentication

| Auth Type | Description |
|-----------|-------------|
| **None** | No authentication |
| **Basic Auth** | HTTP Basic (username/password in header) |
| **Bearer Token** | Token in HTTP header |
| **API Key** | Key in a header you name (`headerName`, default `X-API-Key`) |
| **WS-Security (UsernameToken)** | A `wsse:Security` header with a UsernameToken in the SOAP envelope (OASIS WSS 1.0 UsernameToken profile) |

```json
{
  "authType": "BASIC_AUTH",
  "authConfig": {
    "username": "ws-user",
    "password": "ws-pass"
  }
}
```

### WS-Security UsernameToken

Choose **WS-Security (UsernameToken)** in the connector's authentication settings (offered for SOAP connectors), or send `"authType": "WS_SECURITY"`:

```json
{
  "authType": "WS_SECURITY",
  "authConfig": {
    "username": "ws-user",
    "password": "ws-pass",
    "passwordType": "PasswordDigest"
  }
}
```

| Field | Description |
|-------|-------------|
| `username`, `password` | Required |
| `passwordType` | `PasswordText` (default): the password is sent as is, so use HTTPS. `PasswordDigest`: Base64(SHA-1(nonce + created + password)) is sent with a fresh random nonce and the creation time, instead of the password |
| `includeNonce` | `true` adds the Nonce and Created elements to a `PasswordText` token, for services that require them. `PasswordDigest` always has them |
| `includeTimestamp` | `true` adds a `wsu:Timestamp` valid for five minutes |

The header carries `soapenv:mustUnderstand="1"`. `PasswordDigest` and the timestamp use the backend's clock, so a service that checks freshness needs it to be accurate. When a call fails, the request returned in the error detail (to the AI client and in the tool test) shows `<wsse:Security><!-- redacted --></wsse:Security>` in place of the header, and a Security block echoed in the service's response is redacted the same way.

> **Not implemented yet:** signed or encrypted WS-Security messages (X.509 tokens, XML Signature, XML Encryption) and TLS client certificates. The `CERTIFICATE` auth type exists in the data model, but the SOAP engine sends no client certificate, so a service that requires one will reject the call.

---

## Example: SOAP Service Integration

Suppose you have a legacy CRM with a WSDL at `https://crm.internal.com/CustomerService?wsdl` that exposes operations like `GetCustomer`, `SearchCustomers`, `UpdateCustomer`.

```bash
# 1. Create the SOAP connector
CONNECTOR_ID=$(curl -s http://localhost:4000/api/connectors \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "CRM Customer Service",
    "type": "SOAP",
    "baseUrl": "https://crm.internal.com",
    "specUrl": "https://crm.internal.com/CustomerService?wsdl",
    "authType": "BASIC_AUTH",
    "authConfig": {
      "username": "api-user",
      "password": "api-pass"
    }
  }' | jq -r '.id')

# 2. Auto-import all SOAP operations as tools
curl -s http://localhost:4000/api/connectors/$CONNECTOR_ID/import-spec \
  -H "Authorization: Bearer $TOKEN"
```

After import, your AI client can call tools like `GetCustomer`, `SearchCustomers`, etc., and AnythingMCP builds the SOAP envelope and makes the call.

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| WSDL fetch fails | Ensure the WSDL URL is reachable from the AnythingMCP backend container; **Test connection** says whether the service answered and why no WSDL could be read. The WSDL is read without credentials |
| Parameter order errors | AnythingMCP respects WSDL parameter ordering; verify the WSDL definition matches service expectations |
| "Unknown operation" or a schema fault | The engine sends document/literal requests: the body element is the operation's input element from the WSDL (`<tns:GetItemRequest>`), or the operation name (`<tns:GetItem>`) when the WSDL names it so, as WCF and JAX-WS do. Tools imported before this was read from the WSDL keep the operation name: re-import the WSDL to pick up the input element. Parameter elements are written with the `tns:` prefix unless the schema declares them unqualified; tools imported before that was read keep the prefix, so re-import the WSDL of a JAX-WS or RPC service that answers with an unmarshalling fault. RPC/encoded style is not supported. Tools imported before nested values were supported describe complex parameters as text: re-import the WSDL so they take objects and lists |
| A changed WSDL is not picked up | Tools keep the metadata read at import: re-import the WSDL. A tool that lacks some of it (an empty `soapAction` is common) reads it from the WSDL at call time and keeps it for up to 10 minutes (1 minute when the WSDL could not be read) |
| WCF endpoint mismatch | Set `baseUrl` to the actual service URL; AnythingMCP overrides WSDL endpoint with this value |
| Authentication failures | Check the credentials and the auth type. For WS-Security, try the other password type, set `includeNonce` or `includeTimestamp` if the service asks for them, and check the backend's clock for `PasswordDigest`. A service that requires signed WS-Security messages or a client certificate cannot be called yet (see Authentication) |

---

[Back to README](../../README.md) | [Tool Definition Format](../tool-definition.md) | [API Reference](../api-reference.md)

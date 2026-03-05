# SOAP Connector — SOAP API to MCP

> Bridge legacy SOAP/WSDL web services to MCP. Let AI agents call enterprise SOAP APIs without writing integration code.

[Back to README](../../README.md)

---

## Overview

The SOAP connector lets you expose SOAP web services as MCP tools. It parses WSDL definitions, auto-generates tools for each operation, and handles SOAP envelope construction, WS-Security, and parameter ordering.

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

---

## WCF Service Support

AnythingMCP handles WCF-specific requirements:

- **Parameter ordering** — WSDL-defined parameter order is preserved (WCF services are order-sensitive)
- **Endpoint override** — The connector's `baseUrl` overrides the WSDL endpoint host, useful for internal networks where the WSDL advertises external IPs
- **Multiple bindings** — Each port/binding generates separate tools

---

## Authentication

| Auth Type | Description |
|-----------|-------------|
| **None** | No authentication |
| **Basic Auth** | HTTP Basic (username/password in header) |
| **WS-Security** | SOAP-level security headers |
| **Certificate** | Client certificate authentication |
| **Bearer Token** | Token in HTTP header |

```json
{
  "authType": "WS_SECURITY",
  "authConfig": {
    "username": "ws-user",
    "password": "ws-pass"
  }
}
```

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
| WSDL fetch fails | Ensure the WSDL URL is reachable from the AnythingMCP backend container |
| Parameter order errors | AnythingMCP respects WSDL parameter ordering; verify the WSDL definition matches service expectations |
| WCF endpoint mismatch | Set `baseUrl` to the actual service URL; AnythingMCP overrides WSDL endpoint with this value |
| Authentication failures | For WS-Security, ensure credentials are correct and the security policy matches |

---

[Back to README](../../README.md) | [Tool Definition Format](../tool-definition.md) | [API Reference](../api-reference.md)

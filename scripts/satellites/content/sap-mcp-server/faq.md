### Is there an SAP MCP server?
Yes, this repository: SAP Business One, SAP S/4HANA (Cloud Public Edition, plus on-premise and Private Cloud through OData or HANA SQL) and SAP Concur as MCP tools for Claude, ChatGPT and Copilot, through AnythingMCP.

### Which SAP systems are covered?
SAP Business One (Service Layer), SAP S/4HANA Cloud Public Edition (OData APIs, OAuth 2.0 via BTP), SAP S/4HANA on-premise and Private Cloud (OData through SAP Gateway, or SQL on the HANA database) and SAP Concur (expense and travel). ECC and BW with SAP Gateway connect through the OData connector as well.

### OData or HANA SQL for S/4HANA on-premise?
OData goes through SAP Gateway: SAP checks the technical user's authorizations on every call and only published services are reachable, which is what SAP's API policy expects from third-party integrations. HANA SQL reads every table and CDS view, with SAP's data dictionary as the map, and aggregates on the database; it bypasses SAP's application authorizations, so the database grants are the boundary, and your HANA licence must allow third-party SQL access. Both can run on the same MCP server.

### Can the AI change data in SAP?
SAP Business One can create sales orders and Concur can submit expense reports and act on approvals. The S/4HANA tools only read: the OData built-ins are read-only, and the HANA session runs `SET TRANSACTION READ ONLY`. Roles decide which tools each MCP server exposes.

### Have these been tested against live SAP systems?
The HANA SQL connector was verified on 2026-09-27 against an SAP S/4HANA 2025 Private Cloud system, every tool. The OData engine was verified against public OData services, not yet against a live SAP Gateway. The other adapters follow SAP's API documentation; the "Verified live" column says so per product.

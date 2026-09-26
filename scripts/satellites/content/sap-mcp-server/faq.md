### Is there an SAP MCP server?
Yes, this repository: SAP Business One, SAP S/4HANA Cloud and SAP Concur as MCP tools for Claude, ChatGPT and Copilot, through AnythingMCP.

### Which SAP systems are covered?
SAP Business One (Service Layer), SAP S/4HANA Cloud Public Edition (OData APIs, OAuth 2.0 via BTP) and SAP Concur (expense and travel). S/4HANA on-premise and ECC connect through their Gateway OData services as a custom REST connector, or read-only through the database.

### Can the AI change data in SAP?
SAP Business One can create sales orders and Concur can submit expense reports and act on approvals. The S/4HANA Cloud tools only read. Roles decide which tools each MCP server exposes.

### Have these been tested against live SAP systems?
Not yet; the "Verified live" column says so per product. The adapters follow SAP's API documentation.

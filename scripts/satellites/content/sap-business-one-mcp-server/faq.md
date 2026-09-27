### Is there an SAP Business One MCP server?
Yes, this one. It connects the SAP Business One Service Layer to Claude, ChatGPT and Copilot through AnythingMCP: 12 tools for business partners, items, sales orders, A/R invoices, quotations and delivery notes, plus creating a sales order.

### What do I need to connect it?
The Service Layer host and port (usually 50000), the company database name and a B1 user with API access. The connector logs in and reuses the session cookie.

### Can the AI create or change documents in SAP B1?
It can create sales orders with `b1_create_order`; everything else only reads. Leave that tool off the MCP server's role if the AI should only read.

### Does it work with SAP B1 on HANA and on SQL Server?
It talks to the Service Layer, which ships with SAP Business One on HANA. Installations without a Service Layer can be connected through their SQL database instead, read-only.

### Has this been tested against a live SAP B1 system?
Not yet. The adapter follows SAP's Service Layer documentation; please report what you find.

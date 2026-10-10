### Is there an SAP Business One MCP server?
Yes, this one. It connects the SAP Business One Service Layer to Claude, ChatGPT and Copilot through AnythingMCP: 24 tools for business partners, items, sales documents, A/P invoices and credit memos, incoming and outgoing payments, journal entries, the chart of accounts, bank statements and reconciliations, plus creating a sales order.

### What do I need to connect it?
The Service Layer host and port (usually 50000), the company database name and a B1 user with API access. The connector logs in and reuses the session cookie.

### Can the AI create or change documents in SAP B1?
It can create sales orders with `b1_create_order`; everything else only reads. Leave that tool off the MCP server's role if the AI should only read.

### Does it work with SAP B1 on HANA and on SQL Server?
Yes, as long as the Service Layer runs: it ships with SAP Business One on HANA and, in current 10.0 releases, on SQL Server too. Installations without a Service Layer can be connected through their SQL database instead, read-only.

### Has this been tested against a live SAP B1 system?
Yes. In October 2026 it read a production company database on SQL Server through AnythingMCP Cloud: business partners, items, A/R and A/P invoices, payments, journal entries and the chart of accounts. The reconciliation tools follow SAP's Service Layer reference.

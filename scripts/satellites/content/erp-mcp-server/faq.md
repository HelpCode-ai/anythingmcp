### How do I connect my ERP to Claude or ChatGPT?
Install your ERP's adapter in AnythingMCP, enter its API credentials, and add the MCP server URL to Claude as a custom connector or to ChatGPT as an app. If your ERP is not in the table, connect its REST API, SOAP services or database instead.

### Which ERPs are verified against a real system?
The "Verified live" column says so per system, with the date; each dedicated repository explains how. The others follow the vendor's API documentation and have not been confirmed yet.

### Can the AI change data in my ERP?
Only through tools that write, and only when a role allows them. Most ERP adapters only read; SAP Business One, Odoo, ERPNext and Dynamics NAV have write tools, marked in the tools table.

### Can I connect several ERPs, or an ERP and a shop, at once?
Yes. Every connector on the same MCP server is available in one conversation, so the AI can compare an order in the ERP with its shipment or its marketplace order.

### Does my ERP data leave my network?
Self-hosted, the credentials and the audit log stay on your server; only the fields a tool returns go to the AI model you use, and response mapping removes fields before they do.

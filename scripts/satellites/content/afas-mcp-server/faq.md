### Is there an AFAS Profit MCP server?
Yes, this one. It connects AFAS Profit's REST API to Claude, ChatGPT and Copilot through AnythingMCP: 6 tools covering the standard `Profit_Debtor`, `Profit_Debtor_Invoices` and `Profit_Employees` GetConnectors, plus listing published connectors, inspecting connector field metadata and querying any custom GetConnector.

### What do I need to connect it?
In AFAS Profit, open **Algemeen → Beheer → App connector**, create an app connector, add the GetConnectors the AI should read, and generate a user token. Set `AFAS_ENVIRONMENT` to your 5-digit environment number (for example `12345` for `O12345AA`) and `AFAS_TOKEN` to the base64-encoded XML token (`<token><version>1</version><data>…</data></token>`).

### Can the AI query our own custom GetConnectors?
Yes. AFAS exposes only the GetConnectors you add to the app connector. `afas_profit_list_connectors` lists everything published to your token, `afas_profit_get_connector_metadata` inspects a GetConnector's field IDs and types, and `afas_profit_get_data` queries rows from any GetConnector using AFAS's filter and sort parameters.

### Can the AI change data in AFAS Profit?
No. All 6 tools are read-only HTTP GET requests (4 query GetConnectors and 2 inspect `/metainfo`), and UpdateConnectors are deliberately not exposed. The AI can only read from the GetConnectors you explicitly add to the app connector in AFAS.

### Has this been tested against a live AFAS environment?
Not yet: the adapter follows AFAS's published REST API documentation (`docs.afas.help`) and standard GetConnector schemas. If you use AFAS Profit, a report of what works is very welcome.

### Does it work with ChatGPT and Copilot?
Yes. The same MCP server works in ChatGPT (with a public HTTPS URL such as AnythingMCP Cloud), GitHub Copilot in VS Code, Cursor and Claude Code.

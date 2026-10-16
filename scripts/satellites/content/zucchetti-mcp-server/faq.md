### Is there a Zucchetti MCP server?
AnythingMCP can connect Zucchetti to Claude, ChatGPT and other MCP clients through the API of your Zucchetti installation. A ready-made catalog connector is not generally available yet: Zucchetti does not publish its API documentation, and each product and installation exposes its own API, made available through Zucchetti or your Zucchetti partner. Until that changes, the connection is set up for your installation, from the API your vendor gives you.

### Which Zucchetti products can be connected?
Any Zucchetti product whose installation offers API access under your licence. Zucchetti is not one product: Infinity Zucchetti, Ad Hoc Revolution, HR Zucchetti, Mago and others each have their own API, versions and authentication. Your Zucchetti partner can tell you which API your installation has and what it exposes.

### What Zucchetti data can an AI work with?
Whatever your installation's API exposes and your API user is allowed to read. In the ERP products that usually means anagrafiche (customers and suppliers), documents such as invoices, orders and delivery notes, and articoli; in the HR products, employee and attendance records. Claude can then answer questions across them, such as which orders are still open or which invoices are overdue.

### What do I need from Zucchetti or my partner?
- The API module or licence enabled for your installation.
- The base URL of your installation's API.
- Credentials for an API user, and the authentication method your product uses.
- The API description, ideally as an OpenAPI (Swagger) file.

### How do I connect it today?
Two ways. [Contact us](https://anythingmcp.com/contact) and we set up the connector for your installation with you. Or build it yourself: create a REST connector in AnythingMCP, import the OpenAPI description your vendor gave you, and each operation becomes a tool. Then add the MCP server URL to Claude as a custom connector or to ChatGPT as an app.

### Can the AI change data in Zucchetti?
Only if you let it. Give the MCP server a role that whitelists only the read operations, and the others are invisible to the AI client. Ask your partner for an API user with read-only rights, so Zucchetti enforces the same limit. HR records are personal data: expose only the operations a team actually needs.

### Does Zucchetti data leave my network?
Self-hosted, the credentials and the audit log stay on your server; only the fields a tool returns go to the AI model you use, and response mapping can remove fields before they do. If your Zucchetti installation is only reachable inside your network, run AnythingMCP on that network; AnythingMCP Cloud can only reach an API published on the internet with a valid HTTPS certificate.

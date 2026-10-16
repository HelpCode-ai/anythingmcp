### Is there a TeamSystem MCP server?
AnythingMCP can connect TeamSystem to Claude, ChatGPT and other MCP clients through the API of your TeamSystem product. A ready-made catalog connector is not generally available yet: TeamSystem's API documentation is not public, and API access is enabled per product and per installation by TeamSystem or your TeamSystem partner. Until that changes, the connection is set up for your installation, from the API your vendor gives you.

### Which TeamSystem products can be connected?
Any TeamSystem product for which your licence includes API access. TeamSystem is a family of products (TeamSystem Enterprise, TS Digital, Alyante and others), and each has its own API, versions and authentication. Which one you have, and what its API exposes, is something your TeamSystem partner can confirm.

### What TeamSystem data can an AI work with?
Whatever your product's API exposes and your API user is allowed to read. In an ERP that usually means customers and suppliers, invoices and other documents, items and prices, and accounting records. Claude can then answer questions across them, such as which invoices are overdue or what a customer bought this year.

### What do I need from TeamSystem or my partner?
- The API module or licence enabled for your installation.
- The base URL of the API you will call.
- Credentials for an API user, and the authentication method your product uses.
- The API description, ideally as an OpenAPI (Swagger) file.

### How do I connect it today?
Two ways. [Contact us](https://anythingmcp.com/contact) and we set up the connector for your installation with you. Or build it yourself: create a REST connector in AnythingMCP, import the OpenAPI description your vendor gave you, and each operation becomes a tool. Then add the MCP server URL to Claude as a custom connector or to ChatGPT as an app.

### Can the AI change data in TeamSystem?
Only if you let it. Give the MCP server a role that whitelists only the read operations, and the others are invisible to the AI client. Ask your partner for an API user with read-only rights, so the TeamSystem side enforces the same limit.

### Does TeamSystem data leave my network?
Self-hosted, the credentials and the audit log stay on your server; only the fields a tool returns go to the AI model you use, and response mapping can remove fields before they do. If your TeamSystem installation is only reachable inside your network, run AnythingMCP on that network; AnythingMCP Cloud can only reach an API published on the internet with a valid HTTPS certificate.

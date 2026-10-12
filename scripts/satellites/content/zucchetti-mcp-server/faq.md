### Is there a Zucchetti MCP server?

AnythingMCP provides an adapter for accessing a Zucchetti Infinity-style REST endpoint through MCP. It exposes tools for discovering services, listing records, reading an individual record, and listing anagrafiche, documenti and articoli. The adapter is unlisted and has not been verified against a live installation.

### How do I connect my Zucchetti installation?

Ask your Zucchetti partner for the REST endpoint, service path prefix, API user and documentation for your licensed product and version. Configure `ZUCCHETTI_URL`, `ZUCCHETTI_USERNAME` and `ZUCCHETTI_PASSWORD`. Set `ZUCCHETTI_COMPANY` when your installation hosts multiple companies and requires a company code.

Zucchetti offers multiple products and API surfaces. Do not assume that every installation uses the same endpoint or resource names.

### How should I check the connection?

Start with the `zucchetti_list_services` tool. It sends a GET request to `/services`. If the request returns 404, confirm the endpoint URL and service path prefix with your partner before troubleshooting individual resources.

### Which records can I query?

The adapter includes tools for anagrafiche (customer and supplier master records), documenti (documents such as invoices, orders and delivery notes), and articoli (catalogue items). The generic `zucchetti_list_records` and `zucchetti_get_record` tools accept a resource name, such as `anagrafiche`, `documenti`, `articoli` or `dipendenti`.

Available resources, fields, search behavior and document type codes depend on your specific installation. Follow your partner's API documentation.

### Can the AI change data in Zucchetti?

The six tools declared by this adapter use HTTP GET requests to read data. They do not declare create, update or delete operations. Access is still limited by the permissions of the configured API account, so use an account with only the necessary read permissions.

### Why do I get a 401, 403 or 404 response?

- **401 Unauthorized:** Check the username, password and authentication requirements for your installation.
- **403 Forbidden:** Check the API user's permissions and whether the required API access has been enabled.
- **404 Not Found:** Check the endpoint URL, service prefix, resource name and the API paths supported by your product version.

These are general troubleshooting suggestions, not confirmed behavior for every Zucchetti product.

### Does this adapter work with every Zucchetti product?

No compatibility guarantee is made. The adapter is deliberately generic and unverified against live tenants. Confirm the supported API paths and fields with your partner before relying on the results in production.

### Can I use this adapter with AnythingMCP Cloud or self-hosted AnythingMCP?

The adapter is intended to be used through an AnythingMCP deployment. For Cloud, the configured endpoint must be reachable from the service and use a valid TLS certificate; self-signed certificates are not supported by this adapter's connection setup. For private or internal endpoints, a self-hosted deployment on the appropriate network may be necessary, and outbound-host restrictions may need configuration.

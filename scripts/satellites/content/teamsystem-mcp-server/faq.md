### Is there a TeamSystem MCP server?

AnythingMCP provides an adapter for selected TeamSystem API endpoints. Its six tools cover customers, suppliers, invoices and catalogue items. The adapter is unlisted and has not been verified against a live tenant.

### How do I connect TeamSystem?

Ask your TeamSystem partner to enable the appropriate APIs for your product and tenant. Register or configure an application through the TeamSystem developer portal, obtain its client ID and client secret, and confirm the scopes and tenant ID required for your integration.

Configure these environment variables:

- `TEAMSYSTEM_CLIENT_ID`
- `TEAMSYSTEM_CLIENT_SECRET`
- `TEAMSYSTEM_TENANT_ID`

The adapter uses OAuth 2.0 client credentials with the token endpoint `https://auth.teamsystem.com/oauth2/token` and API base URL `https://api.teamsystem.com`. It sends the tenant identifier in the `X-Tenant-Id` header.

### What can I query?

The declared tools can list and retrieve customer records, list suppliers, list invoices by date range or status, retrieve an individual invoice, and search catalogue items. List tools support pagination; relevant list tools also support search filters.

The available data and supported filters depend on the APIs enabled for your product and tenant.

### Can the AI change data in TeamSystem?

The six tools declared by this adapter use HTTP GET requests. They do not declare create, update or delete operations. The API credentials and tenant permissions still determine which records the connection can read. Use the minimum permissions required for your task.

### Why do I get a 401 or 403 response?

- **401 Unauthorized:** Check the client ID, client secret, token endpoint and OAuth client-credentials configuration.
- **403 Forbidden:** Ask your partner to verify that the relevant API is enabled and that your application has the required scopes and permissions.
- **Unexpectedly empty results:** Confirm the `TEAMSYSTEM_TENANT_ID` value and the tenant associated with the credentials.
- **404 Not Found:** Confirm that the endpoint paths are supported by your particular TeamSystem product and API configuration.

These are troubleshooting guidelines; exact error behavior can vary by API.

### Why does the tenant ID matter?

TeamSystem uses the `X-Tenant-Id` header to scope requests to a tenant. A valid token alone does not guarantee that you are querying the intended customer's data. Confirm the tenant ID with your integration partner.

### Does this adapter work with every TeamSystem product?

No compatibility guarantee is made. TeamSystem APIs vary by product line and integration configuration. The declared paths and fields have not been exercised against a live tenant, so verify them with the developer portal and your partner before using the adapter in production.

### Can I use it with AnythingMCP Cloud or self-hosted AnythingMCP?

The adapter is configured for use through AnythingMCP. Choose a deployment that can reach the TeamSystem API and token endpoints. In either deployment mode, restrict credentials and API permissions to the minimum needed, and follow your organisation's data-handling policies.

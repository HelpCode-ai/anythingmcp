### Is there an Odoo MCP server that works with Odoo Online?
Yes. This one talks to Odoo's JSON-2 API, which Odoo Online, Odoo.sh and self-hosted Odoo 19 and newer all expose. Odoo 18 and older do not have that API; see Troubleshooting.

### How do I connect Odoo to Claude?
Create an API key in Odoo (**My Profile → Account Security → New API Key**), install the connector with your URL, database and key, and add your MCP server URL to Claude as a custom connector. Claude Code and Cursor take the local URL with an API key header.

### Which Odoo models can the AI use?
Any model the API key's user can access. `odoo_search_read`, `odoo_read`, `odoo_search_count` and `odoo_fields_get` work on every model (CRM, sales, purchase, inventory, accounting, projects…); four convenience tools cover partners, sales orders, invoices and products.

### Can the AI change data in Odoo?
Yes, if you let it: `odoo_create`, `odoo_write` and `odoo_call_method` write to the live database and trigger Odoo's automations. To start read-only, give the AI a role that whitelists only the read tools, and create the API key with a user whose access rights are limited.

### Does it work with ChatGPT and Copilot too?
Yes. The same MCP server URL works in ChatGPT (which needs a public HTTPS URL such as AnythingMCP Cloud), GitHub Copilot in VS Code, Cursor and any other MCP client.

### Why does the AI say there are no records when I know there are?
The API key inherits its owner's access rights and record rules. A restricted user sees fewer rows rather than an error, so check which user created the key.

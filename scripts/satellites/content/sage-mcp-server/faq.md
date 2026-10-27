### Is there a Sage 100 MCP server?
Yes, this one. It connects the German Sage 100 ERP (via the Sage 100 Web API / OData service) to Claude, ChatGPT and Copilot through AnythingMCP with 6 read-only tools for `$metadata` discovery, `Adressen`, `Artikel`, `Belege` and arbitrary OData entity sets.

### Is this for German Sage 100 or US Sage 100cloud?
This connector targets **Sage 100 (DE)**, the German Mittelstand ERP on SQL Server, not the US Sage 100cloud product. It speaks OData against the Sage 100 Web API and uses German entity names such as `Adressen`, `Artikel` and `Belege`.

### What do I need from my Sage partner before setting it up?
Sage 100 does not expose HTTP out of the box: the **Sage 100 Web API** (OData service) must be licensed and installed on your application server by your Sage partner. Ask your partner for the exact OData root URL (`SAGE100_URL`), the company/mandant identifier (`SAGE100_COMPANY`) and a read-only Sage 100 user (`SAGE100_USERNAME`, `SAGE100_PASSWORD`).

### Why should the AI call `sage_100_get_metadata` first?
Every Sage 100 installation is heavily customised by the implementing partner, so no two systems publish the exact same OData entity sets and custom fields. Reading `$metadata` first tells Claude or ChatGPT which entity sets and field names exist on your server before it queries them with `sage_100_query`.

### Can the AI change data in Sage 100?
No. All 6 tools send HTTP GET requests, and Sage 100 enforces the permissions of the configured Sage user on top of the Web API.

### Has this been verified against a live Sage 100 installation?
Not yet: Sage distributes the Sage 100 Web API documentation only through its partner portal, so the default route and entity names have not been tested against a live server. If you run Sage 100 with the Web API enabled, feedback and path corrections are very welcome.

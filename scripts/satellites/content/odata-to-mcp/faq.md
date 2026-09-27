### How do I turn an OData service into an MCP server?
Create an OData connector in AnythingMCP with the service root as base URL and the service's auth, then add the MCP server URL to your AI client. Five built-in tools let the model find the service, read its model and query it; no import and no code.

### Does it support OData V2 and V4?
Both. The version is detected from `$metadata`. V2 answers are requested as JSON, `/Date()/` values come back as ISO strings and decimals as strings, so amounts are not rounded. V4 `$apply` and `$search` are passed through where the service supports them.

### Does it work with SAP Gateway?
Yes, that is the first-class case. In SAP Gateway mode the connector searches SAP's V2 and V4 service catalog, sends `sap-client` and `sap-language`, reads SAP's annotations (labels, the currency or unit field of an amount, text fields, analytical and parameterised views) and fetches a CSRF token before a write. For S/4HANA on-premise and Private Cloud, the SAP S/4HANA (OData) catalog adapter adds ready tools for released APIs and a guide.

### Can the AI change data through OData?
Not through the built-ins, and not through the tools imported from `$metadata` (`<set>_list`, `<set>_get`): they only read. Tools you write by hand can POST, PATCH or DELETE; leave them out of the MCP server's role if the AI should only read.

### How is this different from importing an OpenAPI spec?
The connector reads `$metadata` itself, so there is no conversion step, and it knows OData: field names are checked before the call, server paging is followed, composite keys work, and the model sees labels and units instead of bare property names. REST APIs without OData stay with openapi-to-mcp.

### What about services on my internal network?
Self-host AnythingMCP where it can reach them and add their hostnames to `SSRF_ALLOWED_HOSTS`. SAP Gateway ports are usually internal.

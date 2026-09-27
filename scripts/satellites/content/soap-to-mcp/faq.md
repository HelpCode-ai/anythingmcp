### Can Claude call a SOAP web service?
Not directly: Claude, ChatGPT and other AI clients speak MCP, not SOAP. AnythingMCP sits in between. It reads the WSDL, exposes each SOAP operation as an MCP tool, and builds and parses the XML envelopes on every call.

### How do I convert a WSDL to an MCP server?
Create a SOAP connector in AnythingMCP with the WSDL URL and import it; every operation in the WSDL becomes a tool on your MCP server. `scripts/install.sh` does exactly that against the demo service, so you can see the result before pointing it at your own WSDL.

### Does it support WCF services and WS-Security?
WCF services, yes: the WSDL parameter order they are strict about is preserved. For auth the connector sends HTTP Basic, a bearer token or an API-key header. WS-Security SOAP headers and TLS client certificates are not implemented yet, so a service that requires them cannot be called today.

### Do I have to write code or an adapter?
No. The WSDL is the definition. You can rename operations, rewrite their descriptions and hide fields in the visual editor so the model picks the right tool, but none of that is code.

### Can I stop the AI from calling operations that change data?
Yes. Assign the SOAP connector to an MCP server whose role whitelists only the read operations; the other tools are then not visible to that client at all. Every call is also recorded in the audit log.

### What about SOAP services on my internal network?
Self-host AnythingMCP on a machine that can reach them and add their hostnames to `SSRF_ALLOWED_HOSTS`, as the `docker-compose.yml` here does for the demo service.

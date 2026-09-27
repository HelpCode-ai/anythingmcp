### How do I turn an OpenAPI spec into an MCP server?
Create a REST connector in AnythingMCP, import the spec (URL, Swagger UI page or pasted JSON/YAML), and add the MCP server URL to your AI client. Each operation becomes a tool; no code.

### Which spec versions work?
OpenAPI 3.0, OpenAPI 3.1 and Swagger 2.0.

### What if my API has no spec?
Import a Postman collection or cURL commands instead, or define the tools by hand in the visual editor.

### Where do the API credentials go?
Into the connector, encrypted with AES-256-GCM. They are added to each request by AnythingMCP; the model never sees them.

### Can I stop the AI from calling operations that change data?
Yes. Give the MCP server a role that whitelists only the GET operations; the others are invisible to that client.

### What happens when the API changes?
Re-import the spec. Changed operations are updated, new ones added, and removed ones disabled instead of failing at call time.

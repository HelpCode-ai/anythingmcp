# MCP resources

Per-server MCP endpoints expose assigned read-only content through the native
`resources/list` and `resources/read` methods. The resource surface is scoped
to the same connector assignments as tools, so a client cannot discover another
workspace's connector notes.

AnythingMCP publishes a composed server-instructions resource and one resource
for each assigned connector's setup instructions. Persisted `McpResource`
records are also exposed at their configured URI. A record may contain local
`text`, `content`, or JSON `data` in `fetchConfig`; remote URL fetches are
intentionally not followed by the MCP endpoint, which prevents a resource from
being used as an SSRF primitive.

Resource registrations are rebuilt when a client opens a new request. Existing
stateful sessions keep their initial resource snapshot and should reconnect
after connector assignments or resource definitions change.

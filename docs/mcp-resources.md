# MCP resources

Per-server MCP endpoints expose assigned read-only content through the native
`resources/list` and `resources/read` methods. The resource surface is scoped
to the same connector assignments as tools, so a client cannot discover another
workspace's connector notes.

AnythingMCP publishes a composed server-instructions resource and one resource
for each visible connector's setup instructions. A connector is visible when
the caller's role allows at least one of its tools; its resources are therefore
connector-scoped, not individually tool-scoped. Connectors with no registered
tools do not contribute resources. The composed instructions sent during MCP
initialization use this same role-filtered connector set.

Persisted `McpResource` records are exposed at their configured URI. A record
may contain explicitly authored local `text` or `content` in `fetchConfig`.
Arbitrary JSON `data` is withheld because the fetch configuration can contain
credentials-adjacent metadata, and remote URL fetches are intentionally not
followed so a resource cannot become an SSRF primitive. If multiple visible
connectors declare the same URI, AnythingMCP exposes the ambiguity in the
resource description and withholds its content until the URIs are unique.

Resource registrations are rebuilt when a client opens a new request. Existing
stateful sessions keep their initial resource snapshot and should reconnect
after connector assignments or resource definitions change.

-- Explicit MCP tool annotations (spec: ToolAnnotations). NULL = derive the
-- hints from the connector (HTTP verb, query/mutation, readOnly flag, SQL text).
-- Populated by an admin override — required for read-only endpoints exposed
-- over POST, which no heuristic can detect — or captured from an upstream MCP
-- server, whose own annotations are authoritative.
ALTER TABLE "mcp_tools" ADD COLUMN "annotations" JSONB;

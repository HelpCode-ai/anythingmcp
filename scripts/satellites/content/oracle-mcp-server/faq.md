### Is there an Oracle Database MCP server?
Yes, this one. It connects Oracle Database to Claude, ChatGPT and Copilot through AnythingMCP with five tools: list tables, describe a table, find columns by name, run a read-only SQL query, and worked example queries. The driver runs in thin mode for Oracle 12.1 and newer, with no client to install; older servers need Oracle Instant Client on the AnythingMCP host. The connector has not been run against a live Oracle database yet; a report of what works is very welcome.

### How do I create a read-only database user?
Create a user that can only log in and read the tables you grant:

```sql
CREATE USER amcp_reader IDENTIFIED BY "change-me";
GRANT CREATE SESSION TO amcp_reader;
GRANT SELECT ON sales.orders TO amcp_reader;
```

Repeat the `GRANT SELECT` for each table, or grant a read-only role you maintain. Then set `ORACLE_HOST`, `ORACLE_PORT` (usually 1521), `ORACLE_DATABASE`, `ORACLE_USER` and `ORACLE_PASSWORD`. `ORACLE_DATABASE` is the service name, such as `ORCLPDB1`, not the SID.

### Can the AI change data in Oracle?
Not by default. The connector installs read-only and rejects any statement that is not a read until you change that in the connector's settings. That is a guard rail, not a security boundary, so connect with a SELECT-only user as well and the database enforces the same thing on its own.

### Does the database have to be reachable from AnythingMCP?
Yes, AnythingMCP connects to the database directly. A self-hosted AnythingMCP on the same network is the usual setup: add the database host to `SSRF_ALLOWED_HOSTS`, because private addresses are blocked by default. AnythingMCP Cloud can only reach a database that accepts connections from the internet, so point it at a read replica rather than production.

### Why does the AI not find a table I know exists?
Oracle stores unquoted names in upper case, so a table created as `Orders` is `ORDERS`. The user also sees only the tables it has been granted. Results are capped at 1000 rows, and Oracle has no `LIMIT`: queries use `FETCH FIRST n ROWS ONLY` instead.

### Does it work with ChatGPT and Copilot too?
Yes. The same MCP server URL works in ChatGPT (which needs a public HTTPS URL such as AnythingMCP Cloud), GitHub Copilot in VS Code, Cursor, Claude Code and any other MCP client.

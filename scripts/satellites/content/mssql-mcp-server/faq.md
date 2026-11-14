### Is there a SQL Server MCP server?
Yes, this one. It connects Microsoft SQL Server to Claude, ChatGPT and Copilot through AnythingMCP with five tools: list tables, describe a table, find columns by name, run a read-only T-SQL query, and worked example queries. It supports SQL Server logins and Windows (NTLM) authentication. The connector has not been run against a live SQL Server yet; a report of what works is very welcome.

### How do I create a read-only database user?
Create a login and a database user that is only a member of `db_datareader`:

```sql
CREATE LOGIN amcp_reader WITH PASSWORD = 'change-me';
USE sales;
CREATE USER amcp_reader FOR LOGIN amcp_reader;
ALTER ROLE db_datareader ADD MEMBER amcp_reader;
```

Then set `MSSQL_HOST`, `MSSQL_PORT` (usually 1433), `MSSQL_DATABASE`, `MSSQL_USER` and `MSSQL_PASSWORD`. For Windows authentication, also set `MSSQL_DOMAIN`.

### Can the AI change data in SQL Server?
Not by default. The connector installs read-only and rejects any statement that is not a read until you change that in the connector's settings. That is a guard rail, not a security boundary, so connect with a `db_datareader` user as well and the database enforces the same thing on its own.

### Does SQL Server have to be reachable from AnythingMCP?
Yes, AnythingMCP connects to the database directly. A self-hosted AnythingMCP on the same network is the usual setup: add the database host to `SSRF_ALLOWED_HOSTS`, because private addresses are blocked by default. AnythingMCP Cloud can only reach a server that accepts connections from the internet, so point it at a read replica rather than production. For a named instance, use the plain hostname and the instance's TCP port.

### Is there a limit on how much data a query returns?
Results are capped at 1000 rows and flagged when they are cut off. The query runs exactly as written, with no automatic `TOP`, so the AI should aggregate in SQL instead of pulling whole tables.

### Does it work with ChatGPT and Copilot too?
Yes. The same MCP server URL works in ChatGPT (which needs a public HTTPS URL such as AnythingMCP Cloud), GitHub Copilot in VS Code, Cursor, Claude Code and any other MCP client.

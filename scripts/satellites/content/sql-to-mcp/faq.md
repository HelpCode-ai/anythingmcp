### Can Claude query my SQL database?
Yes, through MCP. AnythingMCP connects to PostgreSQL, MySQL/MariaDB, SQL Server, Oracle or MongoDB and gives the model tools to list tables, describe columns and run a query. Claude, ChatGPT, Copilot and Cursor call those tools like any other.

### Is it read-only?
Yes, by default. The query tools only run a single SELECT (or `WITH … SELECT`); AnythingMCP blocks INSERT, UPDATE, DELETE, DDL and stacked statements before they reach the database. Connect with a SELECT-only user as well, as the demo does with `amcp_reader`, so the database enforces the same thing on its own.

### Does my data leave the network?
The database connection stays between AnythingMCP and your database. Query results go to the AI model you use; response mapping drops columns before they do, and every query is logged in your own audit log.

### Which databases are supported?
PostgreSQL, MySQL, MariaDB, Microsoft SQL Server, Oracle and MongoDB have ready connectors with five tools each; SQLite works as a custom database connector.

### Is this text-to-SQL?
It is the model doing text-to-SQL with the schema in front of it: it reads the table and column names first, then writes the query. The quality depends on how readable your table and column names are.

### Can I connect a database on my internal network?
Yes, with a self-hosted AnythingMCP that can reach it. Add the hostname to `SSRF_ALLOWED_HOSTS`.

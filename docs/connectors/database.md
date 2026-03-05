# Database Connector — Database to MCP

> Let AI agents query PostgreSQL, MSSQL, and MongoDB through MCP. Auto-generated schema tools + dynamic query execution.

[Back to README](../../README.md)

---

## Overview

The Database connector lets AI clients query databases directly through MCP. It auto-generates tools for schema introspection, example queries, and dynamic query execution. Supports **PostgreSQL**, **Microsoft SQL Server**, and **MongoDB**.

**Keywords:** Database to MCP, PostgreSQL to MCP, SQL to MCP, MongoDB to MCP, MSSQL to MCP, database MCP bridge, query database with AI, natural language SQL MCP

---

## Supported Databases

| Database | Connection String Format |
|----------|------------------------|
| **PostgreSQL** | `postgresql://user:pass@host:5432/dbname` |
| **Microsoft SQL Server** | `mssql://user:pass@host:1433/dbname` or `Server=host;Database=dbname;User Id=user;Password=pass;` |
| **MongoDB** | `mongodb://user:pass@host:27017/dbname` or `mongodb+srv://...` |

---

## Creating a Database Connector

### Via Web UI

1. Go to **Connectors** > **New Connector**
2. Select **Database** as the type
3. Enter the **Connection String**
4. Set auth type to **Connection String**
5. Click **Create**

### Via API

```bash
# PostgreSQL
curl -s http://localhost:4000/api/connectors \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Production DB",
    "type": "DATABASE",
    "baseUrl": "postgresql://readonly:password@db.example.com:5432/myapp",
    "authType": "CONNECTION_STRING"
  }'

# MongoDB
curl -s http://localhost:4000/api/connectors \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Analytics MongoDB",
    "type": "DATABASE",
    "baseUrl": "mongodb+srv://reader:password@cluster.mongodb.net/analytics",
    "authType": "CONNECTION_STRING"
  }'
```

---

## Auto-Generated Tools

When you create a Database connector, AnythingMCP automatically generates three tools:

### 1. Schema Introspection Tool

Lists all tables/collections with their columns/fields and data types.

```
Tool: {connector_name}_schema
Description: Get the database schema (tables, columns, types)
```

### 2. Example Queries Tool

Returns pre-built example queries that demonstrate how to query this database. These are editable static text — you can customize them in the tool editor.

```
Tool: {connector_name}_examples
Description: Show example queries for this database
```

### 3. Dynamic Query Tool

Executes arbitrary SQL queries (PostgreSQL/MSSQL) or MongoDB operations.

```
Tool: {connector_name}_query
Description: Execute a query against the database
Parameters:
  - query (string): The SQL query or MongoDB operation to execute
```

---

## SQL Databases (PostgreSQL & MSSQL)

### Endpoint Mapping

SQL tools use parameterized queries with `$param` interpolation:

```json
{
  "method": "query",
  "path": "SELECT * FROM users WHERE status = $status AND created_at > $since LIMIT $limit"
}
```

Parameters are safely interpolated into the query.

### Static vs Dynamic Queries

| Method | Description |
|--------|-------------|
| `query` | Dynamic — the AI provides the full SQL query |
| `static` | Static — the SQL is pre-defined, AI only provides parameter values |

Static query example:

```json
{
  "name": "get_active_users",
  "description": "Get active users created after a date",
  "parameters": {
    "type": "object",
    "properties": {
      "since": { "type": "string", "description": "Date (YYYY-MM-DD)" },
      "limit": { "type": "integer", "description": "Max results" }
    },
    "required": ["since"]
  },
  "endpointMapping": {
    "method": "static",
    "path": "SELECT id, name, email, created_at FROM users WHERE status = 'active' AND created_at > $since ORDER BY created_at DESC LIMIT $limit"
  }
}
```

---

## MongoDB

### Native MongoDB Tools

MongoDB connectors generate tools that support native MongoDB operations:

- **Aggregation pipelines** — Complex data transformations and analytics
- **CRUD operations** — Find, insert, update, delete
- **Collection queries** — Filter, sort, project, limit

### Endpoint Mapping for MongoDB

```json
{
  "method": "query",
  "path": "db.collection('users').find({ status: 'active' }).sort({ createdAt: -1 }).limit(10)"
}
```

### Example: MongoDB Aggregation

```json
{
  "name": "sales_by_category",
  "description": "Get total sales grouped by product category",
  "parameters": {
    "type": "object",
    "properties": {
      "year": { "type": "integer", "description": "Year to filter" }
    },
    "required": ["year"]
  },
  "endpointMapping": {
    "method": "query",
    "path": "db.collection('orders').aggregate([{$match: {year: $year}}, {$group: {_id: '$category', total: {$sum: '$amount'}}}, {$sort: {total: -1}}])"
  }
}
```

---

## Security Best Practices

> **Important:** Database connectors execute queries directly against your database.

1. **Use read-only credentials** — Create a dedicated database user with SELECT-only permissions
2. **Limit accessible tables** — Use database-level grants to restrict which tables are visible
3. **Use static queries when possible** — Pre-define queries to prevent unexpected operations
4. **Enable audit logging** — Every query executed through MCP is logged in the audit trail
5. **Use role-based access** — Create MCP roles that whitelist only specific database tools

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Connection timeout | Ensure the database is reachable from the AnythingMCP backend container. Check firewall rules |
| SSL required | Add `?sslmode=require` to PostgreSQL connection strings |
| MongoDB auth fails | Ensure `authSource=admin` is in the connection string if using admin database for auth |
| Schema introspection empty | Check that the database user has read permissions on `information_schema` (SQL) or the target database (MongoDB) |

---

[Back to README](../../README.md) | [Tool Definition Format](../tool-definition.md) | [API Reference](../api-reference.md)

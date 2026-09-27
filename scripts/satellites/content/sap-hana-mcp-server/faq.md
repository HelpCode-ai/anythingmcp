### Is there an SAP HANA MCP server?
Yes, this one. It connects the HANA database under SAP S/4HANA to Claude, ChatGPT and Copilot through AnythingMCP. It brings a guide to SAP's data model, eight tools that read SAP's own data dictionary and organization structure (table and field labels, code values, join paths, released CDS views) and one that runs a `SELECT`, so the model knows what `BUKRS`, `HSL` or `VBRK` mean before it writes a query.

### HANA SQL or OData: which one should I use?
SQL reaches every table and CDS view and aggregates on the database, which suits analytics across finance, sales and inventory. It bypasses SAP's application authorizations, so the database grants are the boundary, and your HANA licence must allow third-party SQL access. OData goes through SAP Gateway, checks the technical user's authorizations on every call and only reaches published services, which is what SAP's API policy expects. The OData route is the SAP S/4HANA (OData) connector in sap-mcp-server; both can run side by side.

### Can the AI change data in SAP?
No. The session runs `SET TRANSACTION READ ONLY`, only a single `SELECT` gets through, locking reads are refused, results stop at 1000 rows and each statement times out after 60 seconds. Create a database user that can only read as well.

### What do I need to connect it?
A HANA database user with `SELECT` on the dictionary tables and the business tables you want read (the grants are under Authentication), the tenant's SQL port, the ABAP schema (usually `SAPHANADB` or `SAPABAP1`) and the SAP client. The HANA port is normally internal, so AnythingMCP runs self-hosted inside the network or reaches it through a VPN.

### Does it work on RISE with SAP and Private Cloud?
Yes; it was verified on an S/4HANA 2025 Private Cloud system. In SAP's private cloud offerings the database user and the network path are requested from SAP.

### Does my SAP licence allow this?
Direct SQL access to the ABAP schema by a third-party application is governed by your SAP HANA licence. A runtime licence bundled with S/4HANA usually does not cover it; a full-use licence does. Check with your SAP account team before you connect production.

### Can it read HR data?
HR and user/password tables are on the connector's denied-tables list by default, and statements naming them are refused. Grant the database user only what the agent needs; `GRANT SELECT ON SCHEMA` also makes HR tables readable.

### Which driver does it use?
SAP's pure-JavaScript `hdb` driver, bundled, with TLS and multi-tenant systems. SAP's native `@sap/hana-client` (Kerberos, `hdbuserstore`) can be installed into your own deployment; AnythingMCP may not redistribute it. A HANA database that is not an S/4HANA system connects as a plain database connector with a `hana://` connection string.

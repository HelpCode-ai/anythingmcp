# SAP HANA to MCP

AnythingMCP connects Claude, ChatGPT and Copilot to SAP HANA through MCP: any HANA database as a Database connector, and SAP S/4HANA's HANA database through the **SAP S/4HANA (HANA SQL)** catalog adapter, which turns SAP's own data dictionary into tools so the model knows what `BUKRS`, `HSL` or `VBRK` mean before it writes a query.

[Back to README](../../README.md) · [Database connector](database.md)

---

## Connection string

```
hana://host:port/?databaseName=TENANT&currentSchema=SCHEMA&sapClient=100&tls=verify
```

| Option | Meaning |
|--------|---------|
| host, port | The tenant database's SQL port: `3<instance>15` for the first tenant, `3<instance>41` and up for further tenants. The system database port `3<instance>13` works too when `databaseName` is set; the tenant's own port is preferable, because the system database may redirect to an internal host name the connector cannot resolve. |
| `databaseName` | Tenant name in a multi-container system. Also accepted as the path: `hana://host:30013/QAS`. |
| `currentSchema` (or `schema`) | Schema for unqualified names, e.g. `SAPHANADB` or `SAPABAP1` for an SAP ABAP system. |
| `sapClient` | Three-digit SAP client. Sets the `CDS_CLIENT` session variable, without which SAP's CDS views return no rows. Plain tables still need a `MANDT` filter. |
| `tls` | `verify` (default), `no-verify` for a self-signed certificate, `off` for an unencrypted connection. The separate `encrypt` and `sslValidateCertificate` options are also accepted. |
| `statementTimeout` | Seconds before a statement is cancelled. Default 60, maximum 600. |
| `driver` | `hdb` (default, bundled) or `hana-client` (see below). |

User and password go in the connector's credentials (encrypted), not in the URL. `saphana://` is accepted as an alias of `hana://`.

## How a HANA connector behaves

- **The session is read-only in HANA itself.** A read-only connector runs `SET TRANSACTION READ ONLY` before the statement, on top of the lexical guard that only lets a single `SELECT` / `WITH … SELECT` through and refuses `SELECT … INTO` and locking reads (`FOR UPDATE`, `FOR SHARE`). The database user's grants are still the real boundary: create a user that can only read.
- **Rows are streamed and capped.** At most 1000 rows are read; a `SELECT *` on a large table never lands in memory.
- **Each statement times out** (60 s by default) and the session is closed, which makes HANA cancel it. Add a server-side limit too, with a workload class mapped to the user:
  ```sql
  CREATE WORKLOAD CLASS "AMCP_READER_WC" SET 'STATEMENT TIMEOUT' = '60', 'STATEMENT MEMORY LIMIT' = '20';
  CREATE WORKLOAD MAPPING "AMCP_READER_WM" WORKLOAD CLASS "AMCP_READER_WC" SET 'USER NAME' = 'AMCP_READER';
  ```
- **Values**: decimals stay strings (no float rounding of amounts); RAW / VARBINARY columns such as SAP GUIDs come back as upper-case hex.
- **Denied tables**: `connector.config.deniedTables` refuses statements naming listed tables ([details](database.md#denied-tables)). The SAP adapter ships with SAP's HR and user/password tables on the list.

## SAP S/4HANA (HANA SQL) adapter

Install it from the catalog (Connectors → Store → *SAP S/4HANA (HANA SQL)*). Its tools:

| Tool | What it gives the model |
|------|------------------------|
| `sap_guide` | A guide to the SAP data model for SQL, by topic: basics (client, dates, leading zeros, currencies), finance (the Universal Journal ACDOCA), sales, inventory, procurement, operations, pitfalls, query recipes. Costs nothing. |
| `sap_org_structure` | Company codes with currency, chart of accounts and fiscal year variant; controlling areas, plants, sales and purchasing organizations. |
| `sap_search_tables` | Tables by name or description, with their row count (tables holding data rank first), flagging S/4HANA compatibility views (`REPLACED_BY`) that plain SQL would read wrongly. |
| `sap_describe_table` | Fields with labels, keys, the currency/unit field of each amount, check tables. |
| `sap_find_fields` | Which tables hold a business field ("net due date"). |
| `sap_field_values` | What the codes of a field mean. |
| `sap_table_relations` | Foreign keys with join conditions, and the text table. |
| `sap_search_cds_views` / `sap_describe_cds_view` | SAP's virtual data model: released views, analytical cubes, measures and dimensions. |
| `sap_query` | One read-only SELECT, capped and timed out. |

### Database user

In the tenant that holds the ABAP schema:

```sql
CREATE USER AMCP_READER PASSWORD "<strong password>" NO FORCE_FIRST_PASSWORD_CHANGE;
ALTER USER AMCP_READER DISABLE PASSWORD LIFETIME;

-- dictionary tools
GRANT SELECT ON SAPHANADB.DD02L TO AMCP_READER;
GRANT SELECT ON SAPHANADB.DD02T TO AMCP_READER;
GRANT SELECT ON SAPHANADB.DD03L TO AMCP_READER;
GRANT SELECT ON SAPHANADB.DD03T TO AMCP_READER;
GRANT SELECT ON SAPHANADB.DD03ND TO AMCP_READER;
GRANT SELECT ON SAPHANADB.DD04T TO AMCP_READER;
GRANT SELECT ON SAPHANADB.DD07T TO AMCP_READER;
GRANT SELECT ON SAPHANADB.DD08L TO AMCP_READER;
GRANT SELECT ON SAPHANADB.DD05S TO AMCP_READER;
GRANT SELECT ON SAPHANADB.DDHEADANNO TO AMCP_READER;
GRANT SELECT ON SAPHANADB.DDFIELDANNO TO AMCP_READER;
GRANT SELECT ON SAPHANADB.ARS_W_API_STATE TO AMCP_READER;
-- organization structure
GRANT SELECT ON SAPHANADB.T001 TO AMCP_READER;
GRANT SELECT ON SAPHANADB.T001K TO AMCP_READER;
GRANT SELECT ON SAPHANADB.T001W TO AMCP_READER;
GRANT SELECT ON SAPHANADB.TKA01 TO AMCP_READER;
GRANT SELECT ON SAPHANADB.TVKO TO AMCP_READER;
GRANT SELECT ON SAPHANADB.TVKOT TO AMCP_READER;
GRANT SELECT ON SAPHANADB.T024E TO AMCP_READER;
-- then the business tables and CDS views your use cases need, e.g.
GRANT SELECT ON SAPHANADB.ACDOCA TO AMCP_READER;
```

`GRANT SELECT ON SCHEMA SAPHANADB TO AMCP_READER` is simpler for broad analytics, but then everything in the schema is readable, including HR data. **SQL does not apply SAP's application authorizations** (company code, sales organization, HR checks): whatever the database user can read, the agent can read.

Before you connect a production system, check two things with your SAP account team:

- **Licence.** Direct SQL access to the ABAP schema by a third-party application is governed by your SAP HANA licence. A runtime licence bundled with S/4HANA usually does not cover it; a full-use licence does. In SAP's private cloud offerings the database user and network path must be requested from SAP.
- **Network.** The HANA SQL port is normally reachable only inside the company network or the SAP private cloud landing zone. Run AnythingMCP there, or reach it through a VPN, and add the host to `SSRF_ALLOWED_HOSTS` (the outbound guard blocks private addresses by default).

### Live check

The adapter's tests include a live suite that runs every tool against a real system:

```bash
RUN_SAP_HANA_LIVE=1 \
SAP_HANA_URL='hana://hana.internal:30015/?databaseName=QAS&currentSchema=SAPHANADB&sapClient=100&tls=no-verify' \
SAP_HANA_USER=AMCP_READER SAP_HANA_PASSWORD='…' SAP_LANGUAGE=E \
npx jest src/adapters/intl/sap-s4hana-hana.live.spec.ts
```

---

## Using SAP's native driver (`@sap/hana-client`)

AnythingMCP ships with `hdb`, SAP's pure-JavaScript HANA driver (Apache-2.0). It covers user/password, TLS, multi-tenant systems and everything the connector does. SAP's native driver, `@sap/hana-client`, adds features such as Kerberos, the secure user store (`hdbuserstore`) and connection pooling. It is published under the SAP Developer License, which does not allow AnythingMCP to redistribute it, so it is never part of the image: you install it into your own deployment. Installing it means accepting SAP's licence terms; check that your SAP agreement covers its use in production.

Platform support: Linux x86_64 (glibc and Alpine/musl), Linux arm64 (glibc only), macOS, Windows. The official AnythingMCP image is Alpine-based, so on **arm64 hosts** use the bundled `hdb` driver or build your own Debian-based image.

Select it per connector with `driver=hana-client` on the connection string, or for every HANA connector with the environment variable `HANA_DRIVER=hana-client`. If it is selected but missing, the connector fails with an error that points here.

### Option A: extend the image

```dockerfile
FROM helpcodeai/anythingmcp:latest
USER root
RUN cd /app/backend \
 && npm install --no-save --omit=dev @sap/hana-client@2 \
 && chown -R appuser:appuser /app/backend/node_modules/@sap
USER appuser
ENV HANA_DRIVER=hana-client
```

```bash
docker build -t anythingmcp-hana .
```

Use `anythingmcp-hana` instead of `helpcodeai/anythingmcp:latest` in your compose file. Rebuild after every AnythingMCP upgrade.

### Option B: mount it as a volume

Install the driver once, for the container's platform, into a host directory:

```bash
mkdir -p /opt/amcp-hana-client
docker run --rm -v /opt/amcp-hana-client:/w -w /w node:26-alpine \
  sh -c 'npm init -y >/dev/null && npm install --omit=dev @sap/hana-client@2'
```

Then mount it and point the backend at it:

```yaml
services:
  anythingmcp:
    image: helpcodeai/anythingmcp:latest
    environment:
      HANA_DRIVER: hana-client
      HANA_CLIENT_PATH: /opt/amcp-hana-client
    volumes:
      - /opt/amcp-hana-client:/opt/amcp-hana-client:ro
```

`HANA_CLIENT_PATH` may be the directory that contains `node_modules/@sap/hana-client` (as above) or the package directory itself. The image upgrades independently of the driver.

### Option C: running from source

```bash
npm install --no-save @sap/hana-client --workspace packages/backend
HANA_DRIVER=hana-client npm run dev:backend
```

### Checking which driver runs

The backend logs the driver with every HANA query at debug level (`SAP HANA query → host:port/TENANT (hana-client)`), and the connector's **Test connection** fails with an explicit message when `hana-client` is selected but cannot be loaded.

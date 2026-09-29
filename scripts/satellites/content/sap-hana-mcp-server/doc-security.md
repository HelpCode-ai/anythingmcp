# Security and permissions

## What the connector enforces

- **Read-only in HANA itself.** Every session runs `SET TRANSACTION READ ONLY` before the statement. On top of that, a guard lets only a single `SELECT` or `WITH … SELECT` through and refuses `SELECT … INTO` and locking reads (`FOR UPDATE`, `FOR SHARE`).
- **1,000 rows at most**, streamed, so a large `SELECT *` never lands in memory.
- **A statement timeout**, 60 seconds by default (up to 600 with `statementTimeout`). The session is closed and HANA cancels the statement.
- **Denied tables.** SAP's HR tables (`PA####`, `PB####`, `PCL#`, `HRP####`) and user and password tables (`USR##`, `USH##`, `RFCDES`, `SSF_PSE_D`) are refused even if the database user may read them. The list is in the connector settings.
- **Credentials** are encrypted with AES-256-GCM and never shown to the model.

## What you decide

- **The database grants are the real boundary.** SQL does not apply SAP's application authorizations (company code, sales organization, HR checks): whatever the database user can read, the model can read. Grant `SELECT` on the dictionary tables and on the business tables your use cases need, not on the whole schema.
- **A server-side cap** with a workload class mapped to the user:

  ```sql
  CREATE WORKLOAD CLASS "AMCP_READER_WC" SET 'STATEMENT TIMEOUT' = '60', 'STATEMENT MEMORY LIMIT' = '20';
  CREATE WORKLOAD MAPPING "AMCP_READER_WM" WORKLOAD CLASS "AMCP_READER_WC" SET 'USER NAME' = 'AMCP_READER';
  ```

- **Who sees which tools.** Assign the connector to an MCP server whose role whitelists only the tools a group may use. Every call is in the audit log with input, output, duration and status.
- **Your licence.** Direct SQL access to the ABAP schema by a third-party application is governed by your SAP HANA licence. A runtime licence bundled with S/4HANA usually does not cover it; a full-use licence does.

## Network

The HANA SQL port is normally reachable only inside the company network or SAP's private cloud landing zone. AnythingMCP runs there, and the host goes into `SSRF_ALLOWED_HOSTS` because private addresses are refused by default. For claude.ai and ChatGPT only the MCP endpoint needs to be published over HTTPS, never the HANA port. Claude Code, Cursor and Copilot also work against a local instance.

## What leaves your network

Tool results. When a user asks a question, the rows `sap_query` returns become part of that conversation with the AI provider (Anthropic, OpenAI, Microsoft), under the terms of the plan you use. Credentials, the connection string and tables nobody asked about do not. Choose the plan and the tools accordingly, and strip fields you do not want to leave the network with a response mapping.

# Compared with other ways to reach SAP

| | This connector (HANA SQL) | SAP S/4HANA (OData) connector | SAP Joule with Claude | A generic HANA MCP server |
|---|---|---|---|---|
| Reads | Any table or CDS view the database user may read | The Gateway services the SAP user may call | Defined by SAP | Any table the user may read |
| SAP authorizations | Not applied: the database grants are the boundary | Checked by SAP on every call | SAP-managed | Not applied |
| Knows SAP's data model | Yes: data dictionary, CDS views, a guide to the model | Yes: SAP's labels from `$metadata` | SAP-managed | No: raw table and column names |
| Where you use it | Claude, ChatGPT, Copilot, Cursor | Claude, ChatGPT, Copilot, Cursor | Inside SAP's applications | Depends on the server |
| Runs | Self-hosted, next to SAP | Self-hosted, next to SAP | On SAP's Business AI platform | Depends on the server |

**HANA SQL or OData?** SQL is strong for totals over millions of rows and analysis across modules, and needs a HANA licence that allows third-party SQL. OData keeps SAP's authorization checks and reaches only published services. Both run side by side in the same AnythingMCP.

**And Joule?** Joule is SAP's own assistant inside SAP's applications, and SAP and Anthropic have announced Claude on SAP's Business AI platform. This connector goes the other way: SAP data inside the AI client your people already use, on a system you run yourself. The two do not exclude each other. More: [SAP Joule or a direct MCP connection](https://anythingmcp.com/vs/sap-joule).

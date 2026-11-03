# OpenAI plugin package: File Search

The package uploaded to the OpenAI plugin portal for the File Search plugin
("Helpcode File Search"). Its MCP server is the fixed tool set at
`https://<host>/mcp/file-search` (see `packages/backend/src/mcp-server/file-search-app-toolset.ts`
and `docs/integrations/chatgpt.md`).

It is a separate plugin from the database plugin on `/mcp/chatgpt-app`.
The display name and package name contain no "MCP": the portal's metadata
check refuses it in a plugin name. A descriptive name alone ("SFTP & NAS File
Search") was refused as too generic, so the name carries the helpcode brand.

## Contents

| File | What it is |
|------|------------|
| `plugin.json` | Portable manifest with the listing, review test cases and publication data under `extensions.com.openai` |
| `mcp.json` | The remote MCP server and its OAuth (dynamic client registration) |
| `skills/get-started/SKILL.md` | Onboarding skill: which tool for which question, how to cite |
| `assets/` | Logo and composer icon (512×512 PNG) |

The review credentials never go into the ZIP: enter them under
**Review details** in the portal.

## Build the ZIP

Run from the repository root:

```bash
cd deploy/openai-plugins/file-search
zip -r ../file-server-search.zip plugin.json mcp.json skills assets -x '.*'
```

Bump `version` in `plugin.json` for every new upload.

## Before submitting

- The review workspace has the demo bucket `amcp-demo-documents` connected as
  an S3 File Search source, fully synced. The test cases refer to its files
  (Brandt Türen price lists and letter).
- The reviewer account signs in with email and password, without MFA or an
  email code.
- `demo_recording_url` points to a published recording (desktop and mobile).
- The domain verification token for this plugin is served at
  `/.well-known/openai-apps-challenge` (`OPENAI_APPS_CHALLENGE_TOKEN`). The
  route serves one token: check whether the portal gives this plugin the same
  token as the database plugin before changing it.

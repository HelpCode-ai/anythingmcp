# Enterprise Edition (EE)

Everything under this directory is licensed under the [AnythingMCP
Commercial License](LICENSE), **not** the AGPL that covers the rest of
the repository.

- `cloud/` — operator-only functionality of AnythingMCP Cloud (e.g.
  onboarding lifecycle emails). Loaded only when `DEPLOYMENT_MODE=cloud`.
- `support/` — the live support chat of the instances we operate (Cloud
  and dedicated enterprise instances), backed by a Libredesk desk: a
  signed widget identity with a workspace snapshot, and an AI triage of
  new conversations. Loaded only when `SUPPORT_CHAT_*` or `LIBREDESK_*`
  are set; self-hosted installations never load it.
- `file-search/` — the File Search sync engine (`files-worker`): source
  drivers (SFTP, FTP/FTPS, WebDAV, S3, mounted folders), setup scans, the
  description drafts, syncs, pauses and the File Share sweeper. It runs as
  its own process (`./start.sh files-worker`), never inside the backend that
  answers MCP calls. Its text extractor lives in `deploy/ee/file-extractor`.
  The connector type, the setup UI and the search tools are AGPL
  (`src/file-search/`); without this engine nothing gets indexed.
- `licensing/` — which edition a self-hosted instance runs (Community
  or a licensed plan) and what each allows. Loaded everywhere; single
  sign-on, SCIM and role sync (Enterprise) are active only with an
  Enterprise licence key (or an existing Business key), during the trial,
  or during the transition period of an upgraded instance.

For licensing questions, contact info@helpcode.ai.

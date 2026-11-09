# File Search and File Share

File Search lets an AI client search inside the documents of a folder: PDF,
Excel, Word, PowerPoint, Outlook `.msg`, `.eml` and text files on an SFTP,
FTP/FTPS, WebDAV (Nextcloud, ownCloud, NAS) or S3 server, or in a folder
mounted into a self-hosted install. AnythingMCP indexes the file names and
the text of every page, keeps the index in sync, and gives the AI tools to
search, read pages, find exact codes and hand the file to the person.

File Share turns files into temporary download links: a file from a File
Search connector, or a file an AI client wrote (a CSV, a report).

- [What you need](#what-you-need)
- [Set up a folder](#set-up-a-folder)
- [Sources](#sources)
- [The tools](#the-tools)
- [Syncing](#syncing)
- [Limits and pauses](#limits-and-pauses)
- [File Share](#file-share)
- [Permissions and governance](#permissions-and-governance)
- [Security](#security)
- [Self-hosted setup](#self-hosted-setup)
- [Troubleshooting](#troubleshooting)

## What you need

| | AnythingMCP Cloud | Self-hosted |
|---|---|---|
| Plan | Every plan, the free trial included, within its limits | Enterprise (on request), an existing Starter or Team licence key, or the 30-day trial. On Community the trial opens File Search only with a registered licence key: the free Community key from **Settings → License** counts. Community has no File Search after the trial. |
| Sources | SFTP, FTP/FTPS, WebDAV, S3 on the internet | The same, plus folders mounted into the install |
| Services | Run by us | `COMPOSE_PROFILES=files` starts `files-worker` and `file-extractor` (see [Self-hosted setup](#self-hosted-setup)) |

Only workspace administrators set up File Search connectors.

## Set up a folder

**Connectors → New → File Search** opens a five-step wizard:

1. **Source.** Pick the protocol and fill in the server, account and folder.
   Shortcuts preset Nextcloud, Synology, QNAP, Fritz!Box and Hetzner Storage
   Box.
2. **Test.** AnythingMCP connects, signs in and lists the folder before
   anything is saved. The result is a checklist (address, reachability,
   encryption, server identity, login, folder) with what to fix when a step
   fails. SFTP host keys and self-signed FTPS certificates are shown as a
   fingerprint to confirm; from then on a different key or certificate is
   refused before the password is sent.
3. **Scan.** A dry run lists the whole folder without indexing it: files per
   folder, types, years. Folders that look like archives (`Alt`, `Old`,
   `Archive…`, `Backup`) are unticked. A budget bar compares the selection
   with your plan while you tick folders, file types or an age limit. When the
   selection is larger than the plan, you cannot continue until it fits or you
   upgrade.
4. **Describe.** The connector's instructions (passed on by every MCP server
   it is on) and a one-line summary that appears in every tool description,
   drafted from the scan. With an AI model configured on the server
   (`KG_LLM_ENABLED`), the wizard can draft them with AI; it states exactly
   what is sent (folder names, file names, the first 2,000 characters of up to
   20 sample files, personal data masked). Without AI the draft is built from
   the folder structure: naming patterns of the folders, recurring
   subfolders, file types, years, language, frequent terms. Edit it before
   saving.
5. **Activate.** Tool prefix, sync interval, MCP servers. The first sync
   starts at once.

The connector's **Files** panel shows the state, progress, counts against the
plan, recent syncs, files that could not be read, the folder tree, the
description and (Enterprise) folder permissions.

## Sources

| Protocol | Notes |
|---|---|
| SFTP | Password or private key. Host key pinned on first use. |
| FTPS (explicit, port 21) / FTPS (implicit, port 990) | A certificate from a public authority is accepted; a self-signed one only by its confirmed fingerprint. Passive data connections go only to the server's own address. |
| FTP (plain) | Sends the password unencrypted; must be acknowledged, and an Enterprise policy can forbid it. |
| WebDAV | Nextcloud and ownCloud (`https://host/remote.php/dav/files/USER/`, with an app password), Synology and QNAP WebDAV, any RFC 4918 server. |
| S3 | AWS S3, DigitalOcean Spaces, MinIO, Hetzner, Wasabi. Folders are key prefixes. |
| Network folder | Self-hosted only: a folder below `FILE_SOURCE_ROOTS` (an SMB/CIFS or NFS share or a NAS volume mounted on the host and bound read-only into the containers). |

The marketplace also lists ready-made entries that open the wizard with the
right settings: S3 bucket, Nextcloud, ownCloud, Synology NAS, QNAP NAS,
Fritz!Box storage and Hetzner Storage Box.

A search for a storage system or for documents in the marketplace, on the
welcome page or from a chat (`setup_find_connectors`) also brings these
entries, next to the system's own API connector: "synology" shows the
Synology DSM connector and Synology NAS (File Search), "nas", "file server",
"Netzlaufwerk" or "pdf" show the File Search entries that fit. The marketplace
and the welcome page add a short hint with a link to the wizard; in a chat the
model gets the wizard link, since File Search is never installed from a chat.
The network folder is suggested on self-hosted installs only. SharePoint,
OneDrive, Google Drive and Dropbox searches get no File Search suggestion:
those have connectors of their own.

The wizard records anonymous funnel events (`file_search_wizard_opened`,
`file_search_test_passed` / `file_search_test_failed`,
`file_search_scan_finished`, `file_search_activated`,
`file_search_locked_shown`) in the `product_events` table, on the Cloud and
self-hosted alike. They carry the protocol, the product preset, the catalog
entry, the test's error kind and the file count as a range (`101-500`), never
a host, path, user name or file name.

SMB is not reached directly from the Cloud: port 445 does not belong on the
internet. Use SFTP or WebDAV on the NAS, or a self-hosted install.

## The tools

Each File Search connector gets these tools, named with its prefix:

| Tool | What it does |
|---|---|
| `<prefix>_guide` | How to search this folder (static) |
| `<prefix>_search` | Full-text search; files with the best page, other matching pages, a snippet and the date; filters for folder, type and dates; newest first on request |
| `<prefix>_find` | Files by name (typo-tolerant) or glob |
| `<prefix>_list` | One folder: subfolders with counts, files with size and date |
| `<prefix>_read` | The text of a file, by pages (`"1-3,7"`) or in windows of characters |
| `<prefix>_grep` | Exact search with two lines of context; spreadsheet rows come with their column names |
| `<prefix>_status` | Sync state, counts, pause reason, content summary |
| `<prefix>_view_page` | One page of a PDF, or an image file (PNG, JPEG, GIF, WebP, TIFF, BMP), as a picture the AI can see: for drawings, stamps, signatures and title blocks that are not in the text. Parameters `path` and `page` (default 1); the answer names the page count. Rendered at most 1600 pixels on the longest side, as JPEG up to 1.5 MB |
| `<prefix>_get_file` | The file itself as a temporary internal link (24 hours), which works in every AI client; images up to 4 MB are attached too. Without File Share on the plan, files up to 4 MB are attached and the AI names the path |
| `<prefix>_share_file` | A temporary link (internal or public); **switched off at install** |

Every tool except the share tools is read-only. The tools tell the model that
file content is data and that instructions inside files are never followed.

`_view_page` reads the file live from your server through `files-worker`,
like `_get_file`, and renders it in the isolated text extractor; on Cloud and
self-hosted alike nothing is stored. Clients such as Claude.ai show the
picture but not an attached PDF. Connectors activated before this tool
existed get it automatically when the backend starts; tools you switched off
or edited stay as they are.

Text extraction: PDF and XPS page by page; Excel (including templates,
macro workbooks and `.xlsb`), ODS and CSV row by row with the header
(`Sheet "Preise" row 2: Artikel=NO-10000 · Breite=750 · Preis=412`); Word and
ODT including templates and macro documents; PowerPoint and ODP slide by
slide, including slide shows and templates; Outlook `.msg` and `.eml` with
the text of their attachments, and `.mbox` mailboxes message by message;
EPUB chapter by chapter; the visible text of SVG drawings; the text, notes
and title-block attributes of ASCII DXF drawings; Apple Pages, Numbers and
Keynote files through their PDF preview, when they were saved with one;
RTF, legacy `.doc`/`.ppt`/`.xls`, and text formats: Markdown, JSON, XML,
HTML, logs, configuration files (YAML, TOML, INI, properties), SQL, LaTeX,
subtitles, calendars and contacts (`.ics`, `.vcf`), GPS tracks (KML, GPX),
and source code in common languages. Other files, such as images, archives,
binary DXF and DWG drawings, are found by name. Scanned PDFs are read with
OCR on Enterprise when the OCR extractor image is used.

## Syncing

Syncing runs in its own service, `files-worker`, never in the process that
answers MCP calls: a slow server or a large first sync does not slow down your
AI clients, and search keeps working on the last index during a sync.

- New and changed files are found by size and modification time (ETag on
  WebDAV and S3); unchanged content is recognised by its SHA-256 and not read
  again; deleted files leave the index.
- A big first sync runs in slices of 25 files, so other workspaces get their
  turn.
- A file that cannot be read is retried on the next syncs and, after three
  failures (at once for password-protected files), stays findable by name
  until it changes.
- **Sync now** queues a sync at once (a number per day depending on the plan).

## Limits and pauses

| | Trial (Cloud) | Starter | Team | Enterprise |
|---|---|---|---|---|
| File Search connectors | 3 | 1 | 3 | by contract (self-hosted: unlimited) |
| Indexed files, all connectors together | 2,000 | 500 | 2,000 | by contract (self-hosted: unlimited) |
| Largest file (Cloud) | 50 MB | 25 MB | 50 MB | 200 MB |
| Automatic sync | daily | daily | daily | down to every 15 minutes (self-hosted: 5) |
| Manual syncs per day | 3 | 1 | 3 | unlimited |
| OCR, folder permissions, workspace policy | – | – | – | ✓ |

The Cloud trial has the Team limits, so you can try everything before you
pick a plan. Self-hosted: the self-hosted 30-day trial has the Team limits too; file size is
set by `FILES_MAX_FILE_BYTES` (default 100 MB). Self-hosted Starter and Team
are no longer sold; existing Starter and Team keys keep the limits above, and
more comes with [Enterprise](https://anythingmcp.com/contact?plan=enterprise).

When a sync finds more files than the plan includes, it **pauses before
downloading anything**. The index stays as it was and the AI keeps searching
it (and is told that newer files may be missing). Administrators get one
e-mail; the Files panel shows the numbers with **Upgrade**, **Edit
selection** and **Resume**. A paused folder is checked again once a day and
resumes by itself when it fits.

When no plan includes File Search any more (a trial ended), syncing stops and
the tools answer that a licence is needed. The index is kept for 30 days.

## File Share

**Settings → File Share** lists the active links (file, access, expiry,
downloads, who created them) with **Revoke**, the plan's limits, and adds the
**File Share** connector (`share_upload`, `share_list`, `share_revoke`) that
lets AI clients publish files they write.

- **Internal** links open for signed-in members of the workspace; **public**
  links for anyone with the link. Links show an interstitial page with the
  file name, size, workspace and expiry, then download through a 60-second
  signed URL with `Content-Disposition: attachment`.
- Only a hash of each link token is stored. Expired and revoked files are
  deleted by the worker.
- Limits: Starter links last at most 24 hours, with 100 MB for the files of
  all active links together and 10 MB per file; Team 7 days, 2 GB, 50 MB. The
  Cloud trial has the Team limits. On the Cloud, program files (`.exe`, `.msi`,
  `.js`, …) cannot be shared.

## Permissions and governance

- Who sees the tools follows the MCP roles, as for every connector.
- **Folder permissions (Enterprise):** allow or deny folders per role inside
  one connector.
  - A role without rules sees everything. Adding a rule for one role never
    changes what other roles see.
  - Allow rules limit a role to those folders (and their subfolders). A user
    with several roles sees the folders any of their roles allows.
  - Deny rules hide a folder and always win, also over an allow.
  - Workspace administrators see every folder.
  - Calls with an MCP API key are not tied to a user, so folder rules do not
    apply to them: give such keys only to servers whose folders everyone with
    the key may see.

  Without Enterprise, connect each folder as its own connector and give it to
  the right roles.
- **Workspace policy (Enterprise):** public links on/off, longest link
  validity, AI drafting on/off, plain FTP on/off.
- Every tool call is in the audit log as usual.

## Security

- Every query on the index is filtered by workspace and connector, and the
  `file_*` tables have Row-Level Security enforced through a dedicated
  database role, so a query that forgot its filter returns nothing of another
  workspace. On a managed database where the application user may not create
  roles, the migration skips the role and the policies apply to the
  application user itself (as long as it is not a superuser).
- Every query on the `file_*` tables, the worker's cross-workspace jobs
  included (picking due syncs and scans, lease renewal, cleanups, deleting
  expired share files), runs one workspace at a time with that workspace set
  for the transaction. No job needs a database user that bypasses
  Row-Level Security. A share link is looked up by the SHA-256 of its token
  under a read-only policy that shows only the row with that hash.
- Self-hosted with an external database: see
  [Database user](#database-user) below.
- Credentials are stored encrypted and decrypted only in `files-worker`; the
  text extractor runs on an internal network with no route out, no database
  and no secrets, read-only, without capabilities.
- On the Cloud, hosts must be public (the SSRF policy also checks redirects
  and the resolved address).

## Self-hosted setup

1. Generate the secrets and add them to `.env`:
   ```bash
   echo "FILES_WORKER_URL=http://files-worker:8891" >> .env
   echo "FILES_WORKER_TOKEN=$(openssl rand -hex 24)" >> .env
   echo "FILE_EXTRACTOR_TOKEN=$(openssl rand -hex 24)" >> .env
   echo "COMPOSE_PROFILES=files" >> .env
   ```
2. For network folders, mount the share on the host (read-only), bind it into
   `app` and `files-worker` (see the comment in `docker-compose.yml`) and set
   `FILE_SOURCE_ROOTS=/mnt/knowledge`.
3. `docker compose up -d`. **Connectors → New → File Search** shows whether the
   worker and the extractor are reachable.

### Database user

File Search works with an ordinary database user: neither superuser nor
`BYPASSRLS` is needed. The default Docker setup connects as the database
owner (a superuser), which works too.

- **`amcp_files`** is a `NOLOGIN` role without `BYPASSRLS` that the File
  Search migration creates and grants to the migrating user. Every query on
  the `file_*` tables switches to it for its transaction (`SET LOCAL ROLE`),
  so the Row-Level Security policies apply even to a superuser. It has
  `SELECT, INSERT, UPDATE, DELETE` on the `file_*` tables, the `file_chunks`
  id sequence, and `SELECT` on `connectors (id, organization_id, type,
  is_active, name)`.
- **Managed databases** (RDS, Azure, Cloud SQL, Supabase…): if the migrating
  user may not create roles, the migration skips `amcp_files` with a notice
  and the policies apply to the application user directly. That is enough as
  long as the user does not bypass RLS. Give the application user the
  ordinary rights on the schema, for example:
  ```sql
  GRANT USAGE ON SCHEMA public TO app_user;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
  ```
  If an administrator creates `amcp_files` later, also grant it to the
  application user (`GRANT amcp_files TO app_user;`) and give it the rights
  listed above.
- Run the migrations with the same user the application uses, or with the
  owner of the tables, so later migrations can alter them.
- At start the `files-worker` log names the mode in use: `role amcp_files`,
  `application user subject to Row-Level Security`, or `application user
  bypassing Row-Level Security` (superuser or `BYPASSRLS` without
  `amcp_files`: then only the queries' workspace filters separate
  workspaces). It warns once when File Search folders exist but no source is
  visible, which means the user lacks rights on the `file_*` tables.

The sync engine (`packages/backend/src/ee/file-search`) and the extractor
(`deploy/ee/file-extractor`) are under the AnythingMCP Commercial License.
All environment variables are listed in `.env.example` under "File Search
and File Share".

## Troubleshooting

| Message | What to do |
|---|---|
| "File Search is not running on this server" | Start the `files` profile; check `FILES_WORKER_URL` and that both tokens are set. |
| "This address is in a private network" | The Cloud cannot reach internal hosts. Self-hosted: add the host to the outbound allowlist (Admin → Settings or `SSRF_ALLOWED_HOSTS`). |
| "The server presented a different host key/certificate" | The server was reinstalled or someone is in between. Check with the server's administrator before confirming the new fingerprint (Files panel → Edit selection → back to Test). |
| "Sync paused: the folder outgrew your plan" | Untick folders or file types (Edit selection) or upgrade. |
| A file "could not be read" | Password-protected, damaged or a scan without OCR. It stays findable by name. |

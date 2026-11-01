# File Search and File Share: concept and implementation plan

Status: implemented on branch `helpcodeai/filesearch` (2026-11-01), not merged. See §17 for what was built and where it differs from the plan.
This file is a working plan, not product documentation. It is not part of
`llms.txt` (`docs/plans/` is outside the generator's sections). Drop it or
move it to an issue before the feature PR merges, if it should not ship.

## 0. Decisions taken

| # | Question | Decision (2026-11-01) |
|---|---|---|
| 1 | File search on the Cloud Starter plan? | Yes, reduced (1 source, small quota). |
| 2 | Public share links on Cloud? | Yes, already on Starter, reduced (short TTL, small storage). Never on the trial. |
| 3 | Paid usage / storage add-on? | No metered usage for now. Every storage-consuming feature has a hard cap per plan. |
| 4 | Reuse `kochfreiburg/koch-filesystem-bridge`? | Allowed. Use it as the reference and copy what is good; rewrite the rest. |

| 5 | Name of the connector type | **File Search** (enum `FILE_SEARCH`), with its sibling **File Share**. See §0.1. |
| 6 | Quotas (revised) | Starter 500 files, Team 2,000 files, both synced once a day; Enterprise down to every 15 minutes on the Cloud. |
| 7 | Sync must never slow down MCP | Sync, extraction and every connection to a customer's file server run in separate containers, never in the backend that answers MCP calls (§3). |
| 8 | Guides | For every AI client with guides on the site (Claude, ChatGPT, Gemini, Copilot, Cursor, Muse), not only Claude (§15). |
| 9 | Setup | A guided wizard, not a form: test before saving, then a **Scan** of the folder that drafts the connector's instructions and tool descriptions, with AI when `KG_LLM_ENABLED` is on and a rule-based draft otherwise (§6A). |
| 10 | Over the limit | The scan says so before activation; a later sync that would exceed the plan **pauses** the whole sync, visibly, with Upgrade and Adjust selection (§6B). |
| 11 | No free self-hosted use | Self-hosted Community gets File Search only during the 30-day trial. After that it pauses until a licence is active (§6B, §10). Where the code lives decides whether this is enforceable (§10.1). |
| 12 | Where the code lives | **Option B** (2026-11-01): the sync engine (`files-worker`) and the extractor are commercial code under `packages/backend/src/ee/file-search/` and `deploy/ee/file-extractor/`; connector type, UI and the search tools stay AGPL. The user explicitly authorised writing under `ee/` for this feature. |
| 13 | UI verification | Every screen of the wizard, the Files tab, the pause and lock states and the File Share page is checked screenshot by screenshot on desktop (1440×900) and mobile (390×844) before the feature is called done (§14, step 12). |

Earlier direction kept: engine in the AGPL core, gating through licence
`features` and `EditionService.assertEnterprise` (same pattern as code mode),
no vector search in v1.

### 0.1 Naming

The name has to say what the user gets (the AI can search inside the
documents of a folder), not how it works.

| Candidate | Problem |
|---|---|
| Files | Too generic: Google Drive, OneDrive, Dropbox and Box are file connectors already. Says nothing about search. |
| File Sync | Describes the mechanism and suggests two-way sync (Dropbox, Syncthing): users would expect us to write to their server or fear their files get copied. |
| Knowledge Base | Already taken twice in the product: a catalog category (`categories.knowledge` = "Knowledge Base" for Notion, Confluence…) and the Knowledge Graph. It also promises a curated, uploaded corpus with generated answers, which is the RAG model that did not work for Koch. |
| **File Search** | Says the benefit, pairs with **File Share**, matches what people type ("search files with AI", "file search MCP"). |

- UI: connector type **File Search**, subtitle "Let AI search inside the
  documents of a folder: PDF, Excel, Word, Outlook". German "Dateisuche",
  Italian "Ricerca file".
- Catalog and SEO: one entry per protocol, because that is what people search
  for: **SFTP**, **FTP / FTPS**, **WebDAV (Nextcloud, NAS)**, **Network folder**
  (self-hosted). Each says "File Search" in its description.
- Code: enum `FILE_SEARCH`, module `src/file-search/`, tables `file_*`.

## 1. Goal and scope

Customers connect folders of files (FTP, FTPS, SFTP, WebDAV / Nextcloud, a
volume mounted into a self-hosted install, later S3) as an AnythingMCP
connector. AnythingMCP keeps an index of the file names and the extracted text
of every supported file, synchronised on a schedule, and exposes MCP tools to
find files by name and content, read them page by page and hand the file itself
to the person (inline or through a temporary link). A second connector, File
Share, lets an agent publish a file it produced as a temporary download link.

Out of scope for v1: vector / semantic search, native SMB from the Cloud,
per-user source credentials, indexing Google Drive / OneDrive / SharePoint /
Dropbox (they have catalog connectors with live search), editing or writing
files on the source.

## 2. What we keep from Koch and Bürkle

From `koch-filesystem-bridge` (FastAPI + Tika + extract-msg + Redis + sqlite-vec):

- Keep: the tool set that works in practice (tree/dir, meta, full text, PDF
  page ranges, grep, index status); change detection on (mtime, size);
  `EXCLUDE_DIRS` folder globs (Alt / Archiv), `INDEX_MAX_ATTEMPTS` with "indexed
  by folder and file name only" fallback; `.msg` via extract-msg with
  attachment text capped at 200,000 characters; the `OCR_MODE=fallback` idea;
  the 18-format list.
- Change: one container per share with its own bearer token → one multi-tenant
  service; semantic index over file name + first 1,500 characters → full-text
  index over every page; grep over a Redis LRU cache (silently empty when
  evicted) → grep over Postgres; Excel through Tika → row-wise rendering with
  the header, so a grep on an article number returns the whole price row.

From Bürkle (`helpcode-v2/docs/buerkle-ftp-ingestion-plan.md`):

- Converting to text is the expensive and decisive step, not the search engine.
- Never read the FTP at question time for search: index it. Residential FTP
  servers allow ~2 connections and ~1 MB/s.
- Explicit FTPS with a self-signed certificate is normal: pin the fingerprint.
- `LIST`-only servers (no `MLSD`) exist; scans of drawings need OCR per page.

## 3. Architecture

```
 AI client ──MCP──▶ backend (NestJS)                     Postgres
                    ├ File Search engine: tools, search SQL ──▶ file_entries / file_chunks (RLS)
                    ├ connectors API + UI (status)        file_sources / file_sync_runs
                    └ share link endpoints ───────────▶ file_shares
                             │                                   ▲
                             │ storage driver (local | S3)       │
                             ▼                                   │
 files-worker (same image, own process) ─────────────────────────┘
   scheduler · leases · sync slices · quota checks · share sweeper
   source drivers: sftp | ftp/ftps | webdav | local | (s3)
        │ bytes over the internal network only
        ▼
 file-extractor (isolated container: no egress, no DB, no secrets)
   PDF pages · Excel rows · Word/PPT · msg/eml · Tika fallback · OCR (Enterprise)
```

**Sync never runs in the process that answers MCP calls.** This holds on the
Cloud and on self-hosted installs alike; there is no "inline" mode.

| Work | Where | Never in the backend because |
|---|---|---|
| Schedule, walk, download, hashing, chunk writes, share sweeper | `files-worker` container (same image, entry point `dist/files-worker.js`, a Nest application context without HTTP server) | network waits, large streams and CPU for hashing would compete with MCP requests on the same event loop |
| Text extraction, OCR | `file-extractor` container | parsing is CPU- and memory-heavy and handles untrusted bytes |
| Opening a connection to the customer's server for `get_file` / `share_file` | `files-worker`, internal endpoint `POST /internal/fetch` (shared secret, internal network) | the backend never holds an FTP/SFTP connection or decrypted source credentials during a tool call |

What the backend does: read the index (SQL with `statement_timeout` 5 s on a
separate pool of at most 5 connections), write a row to request a sync
("Sync now" only sets `next_sync_at = now()`), call the worker's fetch endpoint
with a 30 s timeout and a byte cap.

Guards so the worker cannot slow MCP down through shared resources:
- Container limits on the Cloud: `files-worker` 1 CPU / 1 GB,
  `file-extractor` 1 CPU / 2 GB (3 GB with OCR); the backend keeps its own.
- Its own Postgres pool (max 3 connections, `application_name=files-worker`),
  short transactions (one file's chunks per transaction), `statement_timeout`
  60 s.
- Back-pressure: before each slice the worker checks the number of active
  Postgres sessions and the backend's MCP p95 latency (Prometheus metric
  already exported); above the thresholds it pauses for a minute.
- Concurrency 2 runs on the Cloud and one active run per organization.
- Separate container = separate deploy: the worker can be stopped (`docker
  stop`) without touching MCP traffic; the index stays searchable, only
  freshness stops. Search keeps working while a sync runs.

Self-hosted: `COMPOSE_PROFILES=files` starts `files-worker` and
`file-extractor` together; without the profile the connector type is hidden.
- Coordination happens only through Postgres (leases with `FOR UPDATE SKIP
  LOCKED`), not a Redis queue: no new dependency, the job state commits in the
  same transaction as the index rows, and it survives Redis restarts and
  eviction settings (Bürkle lost BullMQ keys to an `allkeys-lru` Redis).
- `file-extractor` is a separate image (`deploy/ee/file-extractor`), Compose profile
  `files`, internal network only, same hardening as `code-runner`.
- The feature is inert until `FILE_EXTRACTOR_URL` and `FILES_WORKER_URL` are
  set and the worker reports healthy. Without them the connector type is hidden
  in the UI and the API refuses to create one.

## 4. Supported sources

| Protocol | Cloud | Self-hosted | Library | Change detection | Notes |
|---|---|---|---|---|---|
| `sftp` | ✓ | ✓ | `ssh2` | size + mtime (s) | Password or private key (+ passphrase). Host key SHA-256 shown at test connection and pinned on save; a changed key stops the sync with an error. Symlinks skipped in v1. |
| `ftps` (explicit, `AUTH TLS`) | ✓ | ✓ | `basic-ftp` | size + mtime (`MLSD`, else `LIST` + `MDTM` on candidates) | Certificate checked against the system CAs, or pinned by SHA-256 fingerprint for self-signed servers (Fritz!Box, NAS). |
| `ftps-implicit` (port 990) | ✓ | ✓ | `basic-ftp` | as above | |
| `ftp` (plain) | ✓, with an explicit "unencrypted" acknowledgement | ✓ | `basic-ftp` | as above | Password travels in clear text: the form says so. Enterprise policy can forbid it. |
| `webdav` | ✓ | ✓ | HTTP `PROPFIND` through the existing SSRF-guarded outbound HTTP (no new dependency) | ETag, else size + `getlastmodified` | Nextcloud / ownCloud (`/remote.php/dav/files/<user>/`), Synology / QNAP WebDAV, IONOS HiDrive, Box WebDAV… App passwords. |
| `local` | ✗ (refused by `isSelfHosted()`) | ✓ | `fs` | size + mtime (ns) | Only below roots listed in `FILE_SOURCE_ROOTS` (comma-separated), resolved with `realpath` and contained. This is how SMB/CIFS/NFS shares and NAS volumes are connected on-premises (mount on the host, bind read-only into the container). |
| `s3` (phase 4) | ✓ | ✓ | `@aws-sdk/client-s3` | ETag | AWS, DigitalOcean Spaces, MinIO, Hetzner, Wasabi. |

Not supported, with the answer the UI and the guides give:
- SMB/CIFS directly from the Cloud: port 445 must not be open to the internet.
  Use SFTP or WebDAV on the NAS, or self-host and mount the share.
- Cloud drives: use the existing Google Drive, OneDrive, SharePoint, Dropbox
  and Box connectors.

Every driver implements one interface (`packages/backend/src/ee/file-search/sources/`):

```ts
interface FileSourceDriver {
  test(cfg, secrets): Promise<{ ok: true; fingerprint?: string; rootEntries: number } | FileSourceError>;
  walk(cfg, secrets, opts: { exclude: Glob[]; include: Glob[]; maxDepth: number; maxEntries: number },
       onEntry: (e: RemoteEntry) => Promise<void>): Promise<WalkSummary>;
  open(cfg, secrets, path: string, opts: { maxBytes: number }): Promise<Readable>; // aborts above maxBytes
}
```

Network rules for remote drivers on the Cloud: the host goes through
`SsrfPolicyService` (public addresses only, no metadata endpoints); the
address is resolved once and the connection made to that IP; for FTP the
passive-mode data connection must go to the same IP as the control connection
(ignore the address the server returns in `PASV`, verify the `basic-ftp`
option in the spike, wrap otherwise). Self-hosted installs reach internal hosts
through the existing allowlist (`SSRF_ALLOWED_HOSTS`, Admin → Settings).
Per source: `maxConnections` (default 1, max 4).

## 5. Data model

New enum value `ConnectorType.FILE_SEARCH` (migration like
`20261030100000_add_email_connector_type`). Connector settings live in
`connector.config.files`:

```jsonc
{
  "protocol": "sftp",              // sftp | ftp | ftps | ftps-implicit | webdav | local | s3
  "host": "{{FILES_HOST}}", "port": "{{FILES_PORT}}",
  "rootPath": "/Preislisten",      // or a FILE_SOURCE_ROOTS entry for local
  "include": ["**/*"], "exclude": ["**/Alt/**", "**/Archiv*/**"],
  "maxDepth": 32,
  "syncIntervalMinutes": 1440,     // clamped to the plan minimum
  "maxConnections": 1,
  "hostKeySha256": "…", "tlsFingerprintSha256": "…", "allowPlainFtp": false,
  "ocr": false,                    // Enterprise
  "toolPrefix": "preislisten"
}
```

Secrets (password, private key, passphrase) are stored in `authConfig` and
encrypted like every other connector credential.

Tables (all with `organization_id` and `connector_id`, cascade on connector
delete):

(Enum value is `FILE_SEARCH`, see §0.1; the text below says "file connector".)

| Table | Purpose | Key columns |
|---|---|---|
| `file_sources` | 1:1 with a File Search connector: setup state, schedule and lease | `connector_id` PK, `setup_state` (draft/active/syncing/paused_quota/paused_licence/paused_error/paused_admin), `paused_reason`, `paused_at`, `summary` (content summary for tool descriptions), `instructions_draft`, `next_sync_at`, `lease_owner`, `lease_until`, `last_run_id`, `stats` JSONB (files, bytes, text_chars, failed, skipped) |
| `file_scans` | Setup scans (dry runs) | `status` (queued/running/done/failed/cancelled), `progress`, `tree` JSONB (folders to depth 4 with counts/bytes), `types` JSONB, `samples` JSONB (paths + 2,000-character excerpts, deleted after 7 days), `suggestions` JSONB, `truncated`, `created_by_user_id` |
| `file_sync_runs` | One row per run | `trigger` (schedule/manual/api), `status` (queued/running/succeeded/partial/failed/cancelled), counters (listed, new, changed, deleted, extracted, failed, skipped_size, skipped_type, skipped_quota), `started_at`, `finished_at`, `error` |
| `file_entries` | One row per file in the source | `path` (NFC, relative, unique per connector), `name`, `ext`, `dir`, `size`, `mtime`, `etag`, `sha256`, `status` (pending/indexed/name_only/skipped_size/skipped_type/skipped_quota/failed/gave_up), `attempts`, `last_error`, `page_count`, `text_chars`, `indexed_at`, `seen_run_id` |
| `file_chunks` | Extracted text, one row per PDF page or ~4,000-character segment | `entry_id`, `page`, `ord`, `content`, `search_vector` generated `to_tsvector('simple', content)` |
| `file_shares` | Temporary links | `created_by_user_id`, `source` (upload/connector), `connector_id?`, `entry_path?`, `storage_key`, `filename`, `mime_type`, `bytes`, `sha256`, `access` (internal/public), `token_hash` (never the token), `expires_at`, `max_downloads?`, `download_count`, `revoked_at` |
| `file_access_rules` (phase 5, Enterprise) | Folder permissions per role | `role_id`, `pattern` (glob), `effect` (allow/deny) |

Raw SQL in the migration: GIN on `search_vector`, `pg_trgm` GIN on
`file_entries.path`, partial index on `file_entries(status) WHERE status =
'pending'`, RLS policies (§8).

Why Postgres and not Elasticsearch/OpenSearch: no new stateful service on the
Cloud droplet (2–4 GB RAM for a JVM search engine), tenant isolation stays in
one place, and Bürkle's measurement holds: lexical search with trigram + FTS
is what finds article numbers. If the Cloud index ever outgrows one Postgres,
the move is a dedicated Postgres for `file_*` (same schema), then BM25 in
Postgres (`pg_search`), before considering a search cluster.

## 6. Synchronisation (asynchronous)

Loop in `files-worker` (every 30 s):

1. **Schedule.** `UPDATE file_sources SET lease_owner=$me, lease_until=now()+'10 min'
   WHERE connector_id IN (SELECT … WHERE next_sync_at <= now() AND (lease_until IS NULL
   OR lease_until < now()) ORDER BY next_sync_at LIMIT $free FOR UPDATE SKIP LOCKED)`.
   Fairness on the Cloud: at most one active run per organization, at most
   `FILES_WORKER_CONCURRENCY` runs overall (default 2), ordered by
   `next_sync_at` so nobody starves.
2. **Walk.** The driver lists the tree (filters, depth, `maxEntries` 200,000).
   Each entry is compared with `file_entries`: unchanged → `seen_run_id` only;
   new or changed → `pending`; size above the plan's per-file limit →
   `skipped_size`; extension not supported → `name_only` (findable by name).
   After the walk, entries not seen in this run are deleted with their chunks.
3. **Slices.** Pending files are processed in slices of at most 25 files or
   3 minutes. After each slice the lease is renewed and, on the Cloud, the
   source goes back to the queue (`next_sync_at = now()`) if another
   organization is waiting. A 20,000-file backfill therefore interleaves with
   everybody else's syncs instead of blocking them.
4. **Per file.** Quota check (files, text characters) → stream download into
   `/tmp/amcp-files/<run>/<n>` with a byte limit and a running SHA-256 → same
   hash as before → mark indexed, no extraction → otherwise POST to the
   extractor → replace the entry's chunks in one transaction → delete the temp
   file. Extraction errors increment `attempts`; after `FILES_MAX_ATTEMPTS`
   (3) the entry becomes `gave_up` and stays findable by name until the file
   changes. The quota is checked once after the walk (§6B), not file by file:
   a run either fits and indexes everything new, or pauses before downloading
   anything. Nothing is ever deleted because of a quota.
5. **Finish.** Counters into `file_sync_runs` and `file_sources.stats`,
   `next_sync_at = now() + interval` (plus jitter), audit event, metrics.

Triggers: schedule, **Sync now** in the UI (rate-limited per plan), and a
`POST /api/connectors/:id/files/sync` for automation (API key, admin scope).
A crash leaves a lease that expires after 10 minutes; the next worker resumes
from the `pending` rows, so no work is lost and nothing runs twice.

Status shown on the connector's **Files** tab: state (idle / queued / syncing
n of m / error), last and next sync, counters per status, storage used against
the plan, the last 50 errors with path and reason, the host key / certificate
fingerprint, and a **Sync now** button.

## 6A. Setup wizard (UI / UX)

Goal: the admin never fills a blank form with a host, a path and a text field
called "instructions". They pick a source, prove it works, look at what is in
it, decide what to include, and get a connector that already explains its
content to the AI.

The wizard lives at **Connectors → New → File Search** (and opens from the
catalog entries SFTP, FTP / FTPS, WebDAV, Network folder with the protocol
preselected). Five steps, one screen each, progress bar on top, Back always
possible.

**1. Source.** Protocol cards (SFTP, FTP / FTPS, WebDAV / Nextcloud, Network
folder [self-hosted only], S3 later) with one line each on when to use it.
Then the fields for that protocol only, with presets: choosing "Nextcloud"
fills the WebDAV path pattern, "Synology" the port, "Fritz!Box" explicit FTPS
with a self-signed certificate. Help links to the matching guide. Network
folder shows a picker of the roots in `FILE_SOURCE_ROOTS` instead of a path
field.

**2. Test connection** (before anything is saved).
- `POST /api/file-search/test` with the unsaved settings; the backend forwards
  it to `files-worker` (`/internal/test`), which connects, lists the root and
  closes. Credentials are not stored, the call is rate-limited per user (10 per
  10 minutes) and goes through the SSRF policy.
- The result is shown as a checklist, each line green or red with a fix:
  host reachable → TLS / SSH handshake → **fingerprint** (shown in full, "Is this
  your server? Confirm" — mandatory to continue) → login → folder readable → n
  entries at the top level.
- Errors in plain words with the next step: "Port 22 does not answer — is SFTP
  enabled on the NAS?", "Login refused — check user and password; Nextcloud
  needs an app password", "Certificate is self-signed — confirm its fingerprint
  to trust it", "This address is in a private network — AnythingMCP Cloud
  cannot reach it; use the self-hosted edition or open SFTP to the internet".
- On success the connector is saved as a **draft**: `isActive = false`,
  `file_sources.setup_state = 'draft'`, credentials encrypted. A draft has no
  tools on any MCP server and no schedule. Drafts not finished within 7 days are
  deleted (sweeper).

**3. Scan.** Button **Scan folder**. A scan is a dry run in `files-worker`
(table `file_scans`, polled by the UI every 2 s, cancellable):
- **Listing only** for the whole tree (no downloads): counts and bytes per
  folder, per file type, supported vs. name-only vs. too large, oldest and
  newest modification date. Capped at 200,000 entries or 2 minutes; when hit,
  the UI says "We stopped counting at 200,000 files — choose a subfolder".
- **Samples:** up to 20 small supported files (≤ 5 MB), spread over the
  biggest folders, are downloaded and extracted (first 2,000 characters each)
  to learn what the documents are about. Nothing is indexed yet.
- **Suggestions:** exclusions found by name (`Archiv*`, `Alt`, `Old`, `Backup`,
  `~$*`, `Thumbs.db`, `.git`, `@eaDir`, `#recycle`), duplicate year folders,
  temporary files; a tool prefix from the root name.

The screen shows:
- A **folder tree with checkboxes**, each folder with its file count and size,
  suggested exclusions already unchecked and marked "looks like an archive".
- A **budget bar**: "Selected: 1,240 files, 380 MB — your plan: 500 files,
  500 MB". Green when it fits, red when it does not, updating live while the
  admin ticks folders.
- Filters next to the tree: file types (PDF, Excel, Word, Outlook…), "only
  files changed in the last N years".
- Type breakdown (bar), date range, number of files that will be found by name
  only, number too large for the plan.

**When the selection does not fit**, the step cannot be completed and the
screen offers, in this order: deselect folders (the tree), narrow by type or
age (the filters), **Upgrade** (checkout source `file_quota_setup`, shows the
next plan's limits: "Team: 2,000 files — fits"). Self-hosted Enterprise has
no limit and never sees the bar turn red.

**4. Describe.** The connector's **instructions** (inherited by every MCP
server it is on) and the one-line content summary used in its tool
descriptions, drafted from the scan, editable before saving:

- With AI (`KG_LLM_ENABLED=true` and a provider configured, the same switch
  and `chatJson` client the knowledge graph uses): a checkbox, on by default,
  states exactly what is sent: "folder names, file names and the first 2,000
  characters of 20 sample files are sent to <provider/model> to write the
  description". An Enterprise policy can turn AI drafting off for the
  workspace. The prompt asks for JSON: `summary` (≤ 160 characters), `contents`
  (what the folders hold, naming patterns, languages, date range),
  `howToSearch` (which tool for which question, e.g. "article numbers: use
  grep"), `caveats` (old versions, scans), `examplePrompts` (5). Sample text is
  redacted with the existing `redactPii` before sending.
- Without AI, a rule-based draft from the same scan:
  - top folders with counts ("432 folders named `<name> - <number>`" —
    detected by clustering folder names into patterns: text, number, year,
    date);
  - common subfolder names ("most have `Preisliste`, `Konditionen`");
  - type mix and date range ("62 % PDF, 30 % Excel, 2019–2026");
  - language from stop-word counts on the samples (de, en, it, fr, es);
  - the 15 most distinctive words of the samples (TF-IDF against a generic
    word list), offered as clickable chips the admin can add to the summary;
  - fixed "how to search" text for the tool set.
- The admin sees the result as it will reach the AI, can edit it, and can
  press **Regenerate**. The tool descriptions take the summary:
  `pricelists_search` → "Search the text of the supplier price lists (PDF and
  Excel, 432 suppliers, German) …".

**5. Schedule and activate.** Sync interval (the choices the plan allows,
others shown disabled with the plan that unlocks them), which MCP servers get
the connector (checkboxes, default: none), which roles see the tools.
**Activate** sets `isActive = true`, `setup_state = 'active'`, starts the first
sync and opens the connector's **Files** tab with the progress of that sync.

**After setup.**
- The **Files** tab keeps the tree (read-only, with counts and states), the
  last runs, errors, the budget bar and **Edit selection** (reopens step 3
  against the live index).
- When a sync finds the content changed a lot (top folders added or removed,
  file count ±25 %), the tab offers **Update description** with a diff of the
  new draft; the admin's edited text is never overwritten automatically.
- The AI can read the same summary through `<p>_status`, so an agent knows
  what the connector covers before searching.

## 6B. Limits during sync: pause, show, upgrade

States of a source (`file_sources.setup_state`): `draft`, `active`,
`syncing`, `paused_quota`, `paused_licence`, `paused_error`, `paused_admin`.

**Quota pause.** After the walk the worker knows how many supported files and
bytes the selection holds. If indexing the new ones would exceed the plan:
- the run ends as `paused_quota` **before downloading anything**; the index
  stays as it was after the last good sync and search keeps working on it;
- the connector page shows a red banner: "Sync paused: the folder now holds
  612 files, your plan includes 500. The AI still searches the 500 files
  indexed on 30 Oct." with **Upgrade** (checkout source `file_quota`, next plan
  and its limit), **Edit selection**, **Resume** (rechecks);
- admins get one e-mail per pause (existing mailer, owner + admins), and an
  in-app notice on the dashboard;
- `<p>_status` reports the pause and the date of the index, and the
  connector instructions get one generated line ("Index paused since 30 Oct:
  newer files may be missing"), so the AI can warn the user;
- a paused source still lists the folder once a day (cheap, no downloads) and
  resumes by itself when the selection fits again (files removed at the
  source, plan upgraded, selection edited). The licence-changed event also
  triggers an immediate recheck, so an upgrade resumes within a minute.

**Licence pause** (`paused_licence`): the workspace has no plan that includes
File Search (self-hosted Community after the trial, a lapsed key, a Cloud
workspace whose trial ended). Sync stops, the tools answer "File Search needs
a licence — ask your administrator", the connector page shows **Start trial**
(if still available) or **Buy a licence** (checkout source
`file_search_licence`). The index is kept for 30 days, with e-mails at the
start and 7 days before deletion, then removed.

**Usage visible everywhere it matters:** budget bar in the wizard and on the
Files tab, rows on Settings → Licence (files, bytes, File Share storage), and
an 80 % warning before the limit is reached, so the pause is never a surprise.

## 7. Text extraction (`deploy/ee/file-extractor`)

Python 3.12 + FastAPI, one image, stateless.

| Format | How | Output |
|---|---|---|
| PDF | `pypdfium2` text layer, page by page | one chunk per page; empty pages counted for OCR |
| XLSX / XLSM / XLS / ODS / CSV | `openpyxl` / `xlrd` / `odfpy` / `csv`, row-wise | `Sheet "Preise" row 1234: Artikel=UT601 · Breite=875 · Preis=412,00`, one segment per ~200 rows |
| DOCX / PPTX / ODT / ODP | `python-docx`, `python-pptx`, `odfpy` | slides as pages |
| MSG | `extract-msg`: headers, body, attachments (one level, 200,000 characters) | |
| EML | Python `email` | |
| TXT / MD / HTML / XML / JSON / RTF | direct or `striprtf` / HTML to text | |
| DOC / PPT / anything else Tika reads | Apache Tika (bundled, `-Xmx768m`) as fallback | |
| Scans (Enterprise) | RapidOCR (PP-OCRv4 ONNX, CPU) on pages with < 50 characters, 200 dpi | per-page text, `ocrPages` count |

Contract: `POST /extract` (multipart `file`, `filename`, `options` `{ocr,
maxChars}`) → `{ ok, pages: [{ page, text }], meta: { title?, author?,
pageCount? }, truncated, ocrPages, error?: { kind: unsupported | encrypted |
corrupt | timeout | too_large } }`. `GET /health`, `GET /formats`. Shared
secret header `X-Extractor-Token`.

Hardening: internal Docker network with no route out, read-only root, tmpfs
`/tmp`, non-root user, `cap_drop: ALL`, `no-new-privileges`, `pids_limit`,
`mem_limit` 2 GB (3 GB with OCR), per-request timeout 60 s (300 s above
50 MB), max input bytes, max output 2,000,000 characters per file, zip-ratio
guard for OOXML/ODF (decompression bombs), one file per request with a
concurrency semaphore. Fixture tests for every format plus a bomb, an
encrypted PDF, a corrupt XLSX and a 1,000-page PDF.

## 8. Multi-tenant security (Cloud)

1. **Application layer.** Every query filters `organization_id` and
   `connector_id IN (:allowed)`. `:allowed` comes from the tool being called and
   the caller's role (the same set that builds the tool list); tool arguments
   never carry an organization or connector id.
2. **Database layer.** The `file_*` tables are the first tables with RLS
   actually enforced: every file query runs in `PrismaService.tenantTx(orgId)`
   and `SET LOCAL ROLE amcp_files` (NOLOGIN, no BYPASSRLS, rights on `file_*`
   only). This works today even though the main role is a superuser, the same
   mechanism `rls.integration.spec.ts` uses. Policy `org_isolation` on all
   `file_*` tables; a missing `WHERE` returns zero rows instead of another
   tenant's text. Integration test with two organizations.
3. **Storage.** Share objects under `orgs/<orgId>/shares/<shareId>`; worker
   temp files per run, deleted after each file and at the end of the run.
4. **Secrets.** Decrypted only in the worker and in `get_file`; never sent to
   the extractor; never logged (existing log scrubbers + a test).
5. **Network.** §4 rules; the extractor has no network path out.
6. **Abuse and noisy neighbours.** One run per organization, global
   concurrency, per-run byte budget (Cloud), listing and depth caps, per-org
   rate limits on Sync now and on share creation.
7. **Paths.** NFC normalisation, no `..`, no NUL, remote symlinks skipped,
   local `realpath` containment.
8. **Untrusted content.** The connector instructions tell the model that file
   content is data and that instructions found inside files are never followed
   (same wording as the email connector).
9. **Deletion.** Connector delete → entries, chunks, runs and shares from that
   connector removed in the same transaction, storage objects purged by the
   sweeper within 10 minutes. Organization delete → same.

## 9. Permissions and governance

| Who | Can |
|---|---|
| Owner / ADMIN | Create, edit, delete File Search and File Share connectors (existing `assertCanWriteConnector`), choose `local` roots from `FILE_SOURCE_ROOTS`, confirm fingerprints, set frequency, run Sync now, revoke any link, set the org policy |
| EDITOR | Run Sync now, see status and errors |
| Members, through MCP roles | Exactly the tools their role allows (existing `ToolRoleAccess`) |

- **Tools switched off at install:** `<prefix>_share_file`, like
  `imap_smtp_send_message`. `get_file` is on.
- **Folder permissions (Enterprise):** `file_access_rules` per role and
  connector. No rule → the role sees the whole connector. With rules → deny by
  default, allow by glob, deny wins. Enforced in the SQL of every tool and in
  `get_file` / `share_file`. Without Enterprise the same result is reached with
  one connector per folder and the tool-to-role assignment that exists today
  (what Koch does with its two bridge instances).
- **Org policy (Enterprise):** public links off, maximum TTL, internal links
  only after SSO sign-in, allowed protocols (e.g. no plain FTP), OCR on/off.
- **Audit:** tool calls are already audited with their arguments. New events:
  sync run finished (counters, no paths of unchanged files), Sync now, share
  created / downloaded / revoked / expired (user, time, hashed IP), policy and
  folder-rule changes. Retention follows the plan.
- **Usage:** Settings → Licence shows files, text and share storage against the
  plan, next to connectors and users (`LicenseGuardService.getUsage`).

## 10. Plans and quotas

Storage limits are **hard** (unlike the soft connector caps): reaching one
stops adding, never deletes, and shows an upgrade nudge with checkout source
`file_quota`. Defaults live in the backend (`files-quotas.ts`), keyed by plan;
an optional licence feature `files` overrides them for Enterprise contracts, so
existing keys need no reissue.

| | Trial | Starter | Team | Enterprise |
|---|---|---|---|---|
| **Cloud** | | €19 | €49 | quoted |
| File Search connectors | 1 | 1 | 3 | per contract |
| Indexed files (total over all connectors) | 500 | 500 | 2,000 | per contract |
| Source volume scanned | 500 MB | 500 MB | 2 GB | per contract |
| Indexed text | 25 M chars | 25 M chars | 100 M chars | per contract |
| Max file size | 10 MB | 25 MB | 50 MB | 200 MB |
| Automatic sync | daily | daily | daily | down to every 15 min |
| Sync now (manual) per day | 1 | 1 | 3 | unlimited |
| File Share: link validity | – | ≤ 24 h | ≤ 7 days | ≤ 90 days |
| File Share: storage of all active links together | – | 100 MB | 2 GB | per contract |
| File Share: max size of one file | – | 10 MB | 50 MB | per contract |
| File Share: new links per day | – | 20 | 200 | per contract |
| File Share: public links | – | ✓ | ✓ | ✓, can be switched off by policy |
| OCR, folder permissions, org policy | – | – | – | ✓ |
| **Self-hosted** | Community | Starter (€12) | Team (€24) | Enterprise |
| File Search | **only during the 30-day trial** (Team limits), then paused | ✓ | ✓ | ✓ |
| File Search connectors | (trial: 3) | 1 | 3 | unlimited |
| Indexed files | (trial: 2,000) | 500 | 2,000 | unlimited |
| Volume, text, file size | | own hardware: `FILES_MAX_FILE_BYTES` (default 100 MB) | same | same |
| `local` volumes | (trial) | ✓ | ✓ | ✓ |
| Automatic sync | (trial: daily) | daily | daily | down to every 5 min |
| File Share | – | internal + public, ≤ 24 h | ≤ 7 days | no limit, internal links without expiry |
| OCR, folder permissions, org policy | – | – | – | ✓ |

The trial mirrors Starter (as it does for connectors) minus File Share.
Self-hosted Community shows File Search in the catalog with a lock and
**Start 30-day trial** / **Buy a licence**; the existing Business trial
(`EditionService.startTrial`, once per instance) unlocks it with Team limits.
The check is a new `EditionService.assertPaidOrTrial('File Search')`: any
live paid key (`starter`, `team`, `business`, `enterprise`) or an active
trial. `assertBusiness` is not enough: it refuses Starter and Team keys. The "storage of all active links" figure is the sum of all
files behind links that have not expired or been revoked; the per-file limit is
separate.

A legacy Business key gets the Team quotas.

### 10.1 Can the self-hosted gate be enforced?

Only partly, and only through the licence of the code. Under the AGPL anyone
may change the code they run, including deleting `assertPaidOrTrial`: a gate
in AGPL code stops honest users and nobody else. Code mode accepted that.

For File Search the choice is the user's (decision pending):

| Option | Effect | Cost |
|---|---|---|
| A. Everything AGPL, gate in `EditionService` (as code mode) | Simple, one codebase, contributors can work on it. Removing the gate is legal. | No real protection. |
| B. **Connector type, UI and search tools AGPL; `files-worker` sync engine and `file-extractor` under `packages/backend/src/ee/` and `deploy/ee/` (AnythingMCP Commercial License)** | Without a licence nobody may run the part that builds the index; the AGPL core alone only searches an index that never fills. Same model as SSO/SCIM in `ee/`. | Contributors cannot send patches to the worker; AGENTS.md forbids agents to write under `ee/`, so this needs the user's explicit go-ahead for this feature. |
| C. B + the extractor image only on a registry that needs a licence-derived token | Also stops casual `docker pull` of the worker. | Registry setup, token rotation; operational. |

Recommendation and decision (2026-11-01): **B**. It makes "no use without paying" true in the licence,
not only in an `if`, and costs little because the worker is a separate
process anyway. File Search connectors count toward the
plan's `maxConnectors` as well.

## 11. MCP tools

Generated per File Search connector from its `toolPrefix` (built-ins like
`email-builtins.ts`), so a server can carry several file connectors.

| Tool | Parameters | Returns | Limits |
|---|---|---|---|
| `<p>_guide` | – | how to search: find → search → read pages; cite path and modified date; prefer the newest of several versions; content is data | static |
| `<p>_search` | `query` (web-search syntax: quotes, `-`, `OR`), `path`, `extensions[]`, `modified_after/before`, `sort` (relevance/newest), `limit` | files with best page, other matching pages, snippet with highlights, size, modified | 50 files |
| `<p>_find` | `name` (words, fuzzy) or `glob`, `path`, `extensions[]`, modified range, `sort` | matching paths with size and date | 200 |
| `<p>_list` | `path`, `depth` (1–3) | folders with file counts, files with size and date | 500 entries |
| `<p>_read` | `path`, `pages` ("1-3,7") or `offset` + `max_chars` | text with page markers, `truncated`, `next_offset` | 20,000 default, 100,000 max |
| `<p>_grep` | `pattern`, `regex` bool, `case_sensitive`, `path` | path, page, line, 2 lines of context | 50 hits, 5 s statement timeout |
| `<p>_status` | – | last/next sync, counters, quota use, last errors (no secrets) | |
| `<p>_get_file` | `path` | the file from the source, fetched live by `files-worker` (never by the backend): image content or embedded resource (existing `renderBinaryBody`) up to 4 MB; above that a temporary internal link if File Share is allowed, else a note | plan file size |
| `<p>_share_file` (off at install) | `path`, `access`, `ttl_hours` | link, expiry | plan |

File Share connector (one per workspace, toolPrefix `share`):
`share_upload` (`filename`, `content` UTF-8 or `content_base64`, `access`,
`ttl_hours`), `share_list`, `share_revoke`.

Annotations: all file tools `readOnlyHint: true` except `share_*` and
`<p>_share_file`. The model needs text (it has `read`); the person needs the
file (link or attachment): the tool descriptions say so.

## 12. File Share

- Storage driver `FILES_STORAGE=local|s3`. Self-hosted default `local`
  (`/data/files` volume). Cloud: S3-compatible bucket (DigitalOcean Spaces) with
  a lifecycle rule as the safety net, plus the worker's sweeper (every 10 min)
  deleting expired and revoked objects.
- Link flow: `https://<app>/s/<token>` (128-bit random, only its hash stored).
  The app checks expiry, revocation, download limit and, for `internal`, a
  signed-in member of the organization (SSO when the policy says so), audits
  the download, then redirects to a 60-second signed URL on a separate
  download host (Cloud: `files.anythingmcp.com`; self-hosted: optional
  `FILES_DOWNLOAD_BASE_URL`, else the same host). Responses carry
  `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`,
  `Content-Security-Policy: sandbox`, so nothing renders as a page on our
  domain.
- Cloud abuse controls: no trial access, executable types refused (`.exe`,
  `.msi`, `.bat`, `.cmd`, `.scr`, `.js`, `.vbs`, `.apk`, `.dmg`, `.jar`…),
  per-org daily link cap, public links show the workspace name on an
  interstitial page, an operator kill switch per organization, a "report this
  link" address on the interstitial.
- UI: Settings → File Share lists active links (who, file, access, expiry,
  downloads) with Revoke.

## 13. Cloud and self-hosted at a glance

| | Cloud | Self-hosted |
|---|---|---|
| Sources | SFTP, FTP(S), WebDAV, later S3 | + mounted volumes (`local`) |
| Worker | separate `files-worker` container | separate `files-worker` container (profile `files`) |
| Extractor | `file-extractor`, internal network | same, Compose profile `files` |
| Internal hosts | not reachable | via `SSRF_ALLOWED_HOSTS` |
| Quotas | hard, per plan | file count / sources / interval per edition; size from env |
| Share storage | S3 bucket + separate download host | local volume, same host by default |
| RLS on `file_*` | on | on |
| Who can use it | every plan incl. trial, per quotas | paid key or the 30-day trial; Community locked after the trial |

## 14. Implementation plan

Each step is one PR against `main` with its issue, tests and docs, merged
behind the off-by-default switch (`FILE_EXTRACTOR_URL`). Rough effort in
developer days.

**Step 0 — Issues (0.5 d).** Epic "File search and File Share" + one issue per
step below; step 1 is the schema issue AGENTS.md requires. Note the Cloud and
self-hosted behaviour in each.

**Step 1 — Schema and repository (2 d).**
- `schema.prisma`: `FILE_SEARCH`, the six tables (incl. `file_scans`); migration with the raw SQL (GIN,
  trigram, generated tsvector, `amcp_files` role, RLS policies, grants).
- `src/file-search/files.repository.ts`: every query through `tenantTx` + `SET
  LOCAL ROLE amcp_files`.
- Tests: migrate-deploy on a throwaway Postgres + `migrate diff` empty;
  RLS integration spec with two orgs (gated `RLS_TEST_DATABASE_URL`).

**Step 2 — Extractor (3 d).**
- `deploy/ee/file-extractor/` (Dockerfile, app, README, fixtures, `test.sh`),
  Compose service under profile `files` in `docker-compose.yml`, documented env
  vars in `.env.example`.
- `src/file-search/extractor.client.ts` (+spec with a fake server).
- Tests: one fixture per format, bomb, encrypted, corrupt, timeout, no-egress
  check from inside the container.

**Step 3 — Source drivers (4 d).**
- `src/ee/file-search/sources/{sftp,ftp,webdav,local}.driver.ts` + `FileSourceDriver`,
  fingerprints, SSRF, path rules. New dependencies: `ssh2`, `basic-ftp`.
- Unit specs with mocked clients; integration specs against containers
  (`atmoz/sftp`, a pure-ftpd with TLS, a WebDAV server) gated
  `RUN_FILES_INTEGRATION=1`; a test that a PASV reply pointing at 10.0.0.1 is
  not followed.
- Worker endpoint `/internal/test` and backend `POST /api/file-search/test`
  (unsaved settings, rate limit, fingerprint in the answer, error kinds mapped
  to the plain-language messages of §6A step 2).

**Step 4 — Sync engine and worker (4 d).**
- `src/ee/file-search/sync/{scheduler,sync-run,slice}.ts`, `src/ee/file-search/files-worker.main.ts` entry,
  `FILES_WORKER_URL`, `FILES_WORKER_CONCURRENCY`, internal `/internal/fetch`, Compose service
  `files-worker` (profile `files`) and the Cloud compose entry.
- Quota check after the walk and the `paused_*` states of §6B (step 8
  provides the numbers; stub defaults here), daily listing-only recheck of
  paused sources.
- Prometheus metrics: runs, files, bytes, extraction seconds, queue age.
- Back-pressure (active Postgres sessions, backend MCP p95) and container
  limits for `files-worker` and `file-extractor` in both compose files.
- Tests: fake driver + fake extractor (new/changed/unchanged-hash/deleted,
  retries → gave_up, quota stop, lease expiry and resume, fairness across two
  orgs, two workers never taking the same source, pause under back-pressure).
- Load test (acceptance gate): MCP p95 of a read tool with and without a
  20,000-file backfill running on the same host; the difference must stay
  under 10 %. A guard test asserts the backend module never imports the
  source drivers.

**Step 4B — Scan and description drafts (3 d).**
- `file_scans` jobs in the worker (listing-only walk with caps, 20 samples,
  suggestions), `GET/POST /api/file-search/scans`, cancel.
- `src/ee/file-search/describe/{rules,ai}.ts`: rule-based draft (folder-name
  patterns, subfolder names, type mix, date range, language, TF-IDF terms) and
  the AI draft through `chatJson` when `KG_LLM_ENABLED`, with `redactPii` and
  JSON validation; fallback to the rule-based draft on any AI error.
- Tests: pattern detection on real-looking trees (supplier folders, year
  folders, project numbers), caps, AI disabled path, malformed AI output,
  nothing sent when the admin unticks AI.

**Step 5 — Engine, tools and connector wiring (4 d).**
- `src/connectors/engines/files.engine.ts`; branches in
  `connectors.service.ts` (test connection, execute) and
  `dynamic-mcp-tools.ts` like `EMAIL`; `files-builtins.ts`; annotations;
  search/find/grep/read SQL; instructions text; `catalog.ts` support.
- Tests: SQL against real Postgres (ranking, filters, snippet, pages,
  grep timeout), tool-role filtering, a cross-tenant attempt returning nothing.

**Step 6 — Frontend: wizard and Files tab (7 d).**
- `connectors/new/file-search/` wizard, five steps of §6A: protocol cards
  with presets, test checklist with fingerprint confirmation and plain-FTP
  acknowledgement, scan screen (folder tree with checkboxes and counts, live
  budget bar, type/age filters, suggestions, Upgrade), describe screen (AI
  consent line, editable draft, Regenerate, preview of what the AI sees),
  schedule/servers/roles and Activate. Catalog entries open it preselected.
- `connectors/[id]`: **Files** tab (state, progress, budget bar, tree,
  runs, errors, Sync now, Edit selection, Update description with diff,
  pause banners with Upgrade / Edit selection / Resume).
- Locked state for self-hosted Community (Start trial / Buy a licence),
  licence page usage rows, dashboard notice for paused sources, messages
  en/de/it.
- Playwright with mocked API: wizard happy path, test failure messages,
  over-limit scan blocks Activate and shows Upgrade, paused banner, locked
  Community state.

**Step 7 — Catalog, docs (2 d).**
- Adapters `intl/sftp.json`, `intl/ftp.json` (FTP + FTPS), `intl/webdav.json`
  (aliases Nextcloud files, ownCloud, Synology WebDAV), `intl/network-folder.json`
  (self-hosted only), with live specs gated `RUN_SFTP_LIVE=1` etc., logos,
  `validate-adapters`, `regenerate-catalog`, `adapter-count --check`.
- `docs/connectors/files.md` (+ README rows, `docs/guides.md`), regenerate
  `llms.txt` / `llms-full.txt`.

**Step 8 — Quotas, licence gate and pauses (3 d).**
- `src/file-search/files-quotas.ts`, `LicenseGuardService.checkFiles*`,
  `getUsage`, `EditionService.assertPaidOrTrial`, checkout sources
  `file_quota_setup`, `file_quota`, `file_search_licence` (backend list +
  frontend `src/lib/checkout-source.ts`).
- Pause e-mails (owner + admins, once per pause), 80 % warning, licence-pause
  retention (30 days, e-mails at start and day 23, purge), recheck on the
  licence-changed event.
- Tests per plan and edition (Community refused after trial, Starter/Team
  keys accepted, Business mapping, override), pause/resume transitions.

**Step 9 — get_file and File Share (5 d).**
- `src/file-search/storage/{local,s3}.storage.ts` (new dependency
  `@aws-sdk/client-s3`), `file_shares` service, `/s/:token` and download
  endpoints, sweeper, share tools, File Share connector, Settings → File Share
  page, Cloud abuse controls.
- Tests: expiry, revocation, download limit, internal link requires a member
  of the same org, token never stored, headers, executable refusal, sweeper.

**Step 12 — UI verification, screenshot by screenshot (2 d).**
- Run backend, worker, extractor and frontend locally against a test SFTP,
  FTPS and WebDAV server (containers) with a seeded folder (supplier-style
  tree, ~700 files: PDF, XLSX, DOCX, MSG, a scan, an encrypted PDF).
- For each screen, desktop 1440×900 and mobile 390×844, light and dark:
  wizard steps 1–5 (incl. test failure, fingerprint confirm, scan running,
  scan over the limit, AI on/off description), Files tab (syncing, idle,
  errors, paused_quota, paused_licence), locked Community state, Settings →
  File Share, the licence usage rows, the shared-link interstitial.
- Check each screenshot: no horizontal scroll on mobile, no clipped text,
  focus order and keyboard use in the wizard, readable contrast, empty and
  error states present. Fix and re-shoot until clean; keep the final set in
  the PR.
- One end-to-end question through a real MCP client (Claude Code CLI) on the
  seeded folder: search → read page → get_file → share link.

**Step 10 — Enterprise (5 d).**
- OCR in the extractor (RapidOCR, optional image tag `-ocr`), folder
  permissions (`file_access_rules` + UI under Roles), org policy, 5-minute
  self-hosted interval, `assertEnterprise` gates.

**Step 11 — S3 source (2 d).**

**Launch (outside the repo where operational).**
1. Self-hosted pilot at Koch: native `local` connector on the
   Lieferanten-Unterlagen share next to the bridge; 20 real price questions
   asked against both; switch when the native one is at least as good.
2. Cloud enablement checklist: Spaces bucket + lifecycle rule, download host
   DNS + Caddy, `files-worker` and `file-extractor` in the blue/green deploy,
   database disk alert at 70 %, independent pen test of the share endpoints and
   the FTP/SFTP SSRF paths.
3. Ship in the next batch release (no release per feature).
4. Website: guides (§15) after a live test, catalog pages, pricing table rows.

Total ≈ 47 developer days for steps 1–9 (the product most customers see), +7
for Enterprise and S3.

## 15. Website guides (SEO)

Guides cover every AI client the site already has guides for: Claude,
ChatGPT, Gemini, Microsoft Copilot (Copilot Studio), Cursor and Meta Muse. Hand-written English
drafts are on the website branch `helpcodeai/file-search-guides` (not merged;
publish only after the live test, every claim checked against the running
feature, like the Google Ads guides in website PR #279). Then translate to
de/it/es/zh/ja/ru with `scripts/translate-guides.py`.

| Slug | Kind | Search intent |
|---|---|---|
| `connect-ftp-sftp-to-claude` | per client | connect an FTP / SFTP server to Claude; FTP MCP server; SFTP MCP |
| `connect-ftp-sftp-to-chatgpt` | per client | same for ChatGPT (plugins page) |
| `connect-ftp-sftp-to-gemini` | per client | same for Gemini CLI |
| `connect-ftp-sftp-to-copilot` | per client | same for Microsoft 365 Copilot / Copilot Studio |
| `connect-ftp-sftp-to-cursor` | per client | same for Cursor |
| `connect-ftp-sftp-to-muse` | per client | same for Meta Muse |
| `search-company-files-with-ai` | client-neutral pillar | search a file server / NAS / network drive with AI; full-text search of PDF, Excel, Outlook files |
| `supplier-price-lists-with-ai` | client-neutral recipe | find purchase prices in supplier price lists with AI (B2B wholesale) |
| `nextcloud-webdav-file-search-ai` | client-neutral | search inside Nextcloud / WebDAV / NAS files with AI (complements the Nextcloud OCS guides) |
| `share-files-from-ai-chat` | client-neutral | send a file from an AI chat as a download link; temporary file sharing for AI agents |

At launch the generators add the remaining per-client pages for every
protocol adapter (`sftp`, `ftp`, `webdav`, `network-folder`, `file-share` ×
6 clients, `generate-connector-guides.mjs` and
`generate-cursor-gemini-guides.mjs`), plus the pillar `<slug>-to-mcp` pages,
once the adapters are in the website's `lib/adapters.ts`.

"Copilot" on the site means Microsoft Copilot through a Copilot Studio agent
(the per-client step is copied from the site's current generated Copilot
guides), not GitHub Copilot.

Keyword volumes were not checked (OpenSEO had no credits on 2026-11-01);
check them before launch and adjust titles.

## 16. Risks and open points

- Cloud database growth: worst case is every Starter at 100 M characters.
  Watch total `file_chunks` size; plan B is a dedicated Postgres for `file_*`.
- Extractor memory with Tika on the Cloud droplet: Tika only as fallback, one
  extractor, 2 GB cap; measure in step 2.
- FTP `LIST` formats vary: keep a corpus of real listings (Fritz!Box,
  IIS, vsftpd, pure-ftpd, ProFTPD) as test fixtures.
- Abuse of public links on the Cloud: controls in §12, pen test before
  enabling.
- Data protection: extracted text and shared files are customer data stored
  by us; add the storage provider to the Cloud sub-processor list and the DPA
  before enabling File Share on the Cloud.

## 17. Implementation notes (2026-11-01)

Built on `helpcodeai/filesearch`, issues #1380–#1389, one commit per step.
Differences from the plan above, and why:

- **Extractor without Tika.** `deploy/ee/file-extractor` reads legacy
  `.doc`/`.ppt`/`.xls` with `antiword`/`catdoc` instead of a bundled Tika
  JVM: 251 MB image instead of ~1 GB, no JVM on the Cloud droplet. `.ppt`
  text comes back as page-less segments (catppt's blocks are not slides).
  OCR is a separate image variant (`--build-arg OCR=1`, RapidOCR, 505 MB).
- **Back-pressure** reads the number of active Postgres sessions
  (`FILES_PG_ACTIVE_MAX`); the backend's MCP p95 is not read by the worker.
  Container CPU/memory limits and the separate process are the main guard.
- **No inline worker mode** at all: self-hosted runs `files-worker` as its
  own container too (`./start.sh files-worker`, Compose profile `files`).
- **Scan listing** is stored on the scan row (`file_scans.tree.listing`), so
  the budget bar is computed exactly from the real file list.
- **Continuation slices** reopen the same `file_sync_runs` row; only a slice
  of an unfinished sync skips the walk (a scheduled or manual sync, a resume
  or a selection change always re-lists the folder, so the quota check sees
  the current content).
- **Password-protected files** are given up at once instead of after three
  attempts.
- **Share links** are `/f/<token>` (the app already used `/s/<token>` for
  setup links).
- **Catalog entries** `sftp`, `ftp`, `webdav`, `network-folder` (type
  FILE_SEARCH, no tools of their own, built-ins injected by `catalog.ts`)
  open the wizard; `AdaptersService.importAdapter` refuses FILE_SEARCH so no
  path skips test, scan and quota.
- **Next plan** shown in limits is the first plan that really includes more
  (Cloud trial → Team, self-hosted trial → Enterprise).

Verified locally against SFTP (atmoz/sftp), FTPS (pure-ftpd, self-signed),
WebDAV (bytemark/webdav), S3 (MinIO) and a mounted folder, with a 508-file
supplier-style seed: wizard, scans, quota pause, licence pause and auto
resume, the MCP tools through a real MCP endpoint, File Share links, RLS.
Backend suite 940/940 suites green; File Search integration specs 5/5.
UI checked screenshot by screenshot at 1440×900 and 390×844, light and dark.

Still open before production: Cloud enablement (Spaces bucket and lifecycle
rule, download host, worker and extractor in the deploy, DB disk alert),
an independent pen test of the share endpoints and the FTP/SFTP SSRF paths,
the licence site's checkout-source allow-list for `file_quota*`, and the
website guides (publish after the live test).


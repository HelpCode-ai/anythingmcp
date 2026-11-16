# File uploads from AI clients

Many connector tools send a file to the app: a listing photo or a digital download on Etsy, a
product image on a marketplace, a document to sign. Those tools take a **link** to the file,
because an MCP tool call carries text and cannot carry the file itself.

When the AI client created the file itself (for example Claude generated an image or a ZIP),
there is no public link. File uploads close that gap. The AI calls **`file_upload_link`** with the
file name and gets a reference such as `amcp-file:3f9c…`, which it passes to the connector tool
in place of the link (for example `file_url: "amcp-file:3f9c…"` on `etsy_upload_listing_file`).
AnythingMCP reads the file from its own storage and sends it to the app. Before that, the file has
to reach AnythingMCP, in one of three ways:

1. **From the AI's code sandbox**, with the `curl` command the tool returns. This only works when
   the sandbox may reach your AnythingMCP address (see below).
2. **In the upload box shown in the chat.** Apps that display MCP Apps (Claude on the web and on
   desktop) show a small box with the tool result. The user saves the file the AI created, picks it
   in the box, and the box tells the AI that the file is there.
3. **On the upload page in a browser** (`browser_upload_url`, `/upload/<token>` on your AnythingMCP
   address): the same thing outside the chat, for apps that do not show the box (ChatGPT, mobile
   apps). No sign-in: the link itself is the credential.

For tools where the app downloads the file itself from a URL (an image `src` in a product, for
example), the AI calls **`file_public_url`** with the reference after the upload and gets a direct
download link that works for one hour.

The two tools appear on an MCP server only when one of its tools sends a file.

## Which AI clients can upload from their sandbox

- **Claude Team and Enterprise:** the organization owner allows `cloud.anythingmcp.com` (or your
  own AnythingMCP host) under Organization settings → Capabilities → code execution ("Package
  managers and specific domains", or "All domains"). Then the AI uploads by itself.
- **Claude Free, Pro and Max:** the sandbox reaches package managers only and there is no setting
  to allow another domain; `curl` answers "CONNECT tunnel failed, response 403". Use the upload box
  or the upload page.
- **ChatGPT:** its code tool has no network access. Use the upload page.
- **Claude Code, Cursor, n8n and your own agents** usually have network access already.

## Limits

| | Largest file | Uploads per day | Kept at once |
|---|---|---|---|
| Cloud trial (no card) | 25 MB | 50 | 500 MB |
| Cloud Starter | 50 MB | 150 | 2 GB |
| Cloud Team / Business | 100 MB | 500 | 10 GB |
| Cloud Enterprise | 200 MB | 5,000 | 50 GB |
| Self-hosted (every edition) | 100 MB, `FILE_UPLOADS_MAX_FILE_BYTES` | no limit, `FILE_UPLOADS_PER_DAY` | no limit, `FILE_UPLOADS_MAX_STORED_BYTES` |

- An upload link works **once**, for **15 minutes**, whichever way the file is sent (sandbox, box or page).
- A file is deleted **8 hours** after upload (`FILE_UPLOADS_TTL_HOURS` on self-hosted). Within
  that time the reference can be used again, for example for the same photo on several listings.
- Program files (`.exe`, `.sh`, `.js`, …) are refused.
- A public link (`file_public_url`) works for one hour and at most 50 downloads per file. It is
  only made for images (JPG, PNG, GIF, WebP), videos (MP4, MOV) and PDFs whose content matches
  the extension; ZIP files and other types can only be used by reference.

## Privacy and security

- A reference works only for tools of the workspace that uploaded the file. Another workspace
  gets the same "unknown or expired" answer as for a reference that never existed.
- Upload links and public links are random, signed and short-lived; only a hash of the upload
  token is stored.
- Anyone who has a public link can download that file until the link expires. Prefer the
  reference whenever the tool takes a file.

## Cloud and self-hosted

- **AnythingMCP Cloud:** files are kept in the same private storage as File Share, under a
  separate area that is emptied automatically.
- **Self-hosted:** every edition, Community included. Files go to the File Share storage
  (`FILES_STORAGE`: a local directory by default, or your S3 bucket). The backend deletes
  expired files every 10 minutes; no extra service is needed. Set `FILE_UPLOADS_ENABLED=false`
  to switch the feature off.

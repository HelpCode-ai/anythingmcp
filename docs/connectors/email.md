# Email (IMAP/SMTP) to MCP

An **Email** connector gives Claude, ChatGPT and Copilot a mailbox through MCP: IMAP to read, search and organise mail, SMTP to send it. It works with any provider that offers IMAP and SMTP with a password or an app password: IONOS, Strato, GMX, web.de, T-Online, Hetzner, all-inkl, Aruba, Gmail and Google Workspace, Yahoo, iCloud, Fastmail, and self-hosted Dovecot/Postfix.

[Back to README](../../README.md) · [Database connector](database.md) · [OData connector](odata.md)

---

## Two ways to set it up

- **From the catalog**: install **Email (IMAP/SMTP)** (`imap-smtp`). The form asks for the servers, ports and login; its setup guide has a table of common providers. Settings live in the connector's variables (`EMAIL_IMAP_HOST`, `EMAIL_IMAP_PORT`, `EMAIL_SMTP_HOST`, `EMAIL_SMTP_PORT`, `EMAIL_USERNAME`, `EMAIL_PASSWORD`, and the optional `EMAIL_IMAP_SECURITY`, `EMAIL_SMTP_SECURITY`, `EMAIL_SMTP_USERNAME`, `EMAIL_SMTP_PASSWORD`, `EMAIL_FROM_ADDRESS`, `EMAIL_FROM_NAME`, `EMAIL_SENT_FOLDER`).
- **By hand**: *New connector*, type **Email (IMAP/SMTP)**. Pick a provider to fill in the servers, or type them; then the username (usually the full address) and the password.

**Not for Microsoft 365 or Outlook.com**: Microsoft no longer accepts passwords for IMAP and SMTP. Use the Microsoft Outlook connector, which signs in with OAuth. **Gmail, Yahoo, iCloud and Fastmail** need an app password (see the adapter's setup guide for where to create one).

## Built-in tools

Every Email connector carries the same tools, named `<prefix>_…`. The prefix is `config.email.toolPrefix` (the catalog adapter uses `imap_smtp`), otherwise the connector name, with `_mail` added when the name does not contain "mail".

| Tool | What it does | MCP hints |
|------|--------------|-----------|
| `<prefix>_list_folders` | Folders with their role (inbox, sent, drafts, trash, junk, archive), message count and unread count | read-only |
| `<prefix>_search_messages` | One folder (default INBOX), by `from`, `to`, `subject`, `text`, `since`/`before` (YYYY-MM-DD), `unread_only`, `flagged_only`. Newest first, `limit` default 20 and at most 100. Returns uid, date, from, to, subject, flags, size, whether there are attachments, and a snippet | read-only |
| `<prefix>_get_message` | Headers, Message-ID, the body as plain text (an HTML-only body is converted to text), and the attachments with index, name, type and approximate size. The body is cut at `max_chars` (default 20,000, at most 100,000) with a marker. Does not mark the message as read unless `mark_as_read` is true | read-only |
| `<prefix>_get_attachment` | One attachment by its index. Text types (txt, csv, json, xml, html, calendar) come back as text; images and other files are attached to the tool result as image or embedded resource. Above 4 MB it is refused | read-only |
| `<prefix>_set_flags` | `seen` (read/unread) and `flagged`, for up to 100 UIDs | write, idempotent |
| `<prefix>_move_messages` | To another folder; returns the new UIDs | write |
| `<prefix>_delete_messages` | Moves to the Trash folder; nothing is deleted permanently, and messages already in the Trash are refused | destructive |
| `<prefix>_save_draft` | IMAP APPEND to the Drafts folder with `\Draft`, for a person to review and send | write |
| `<prefix>_send_message` | SMTP. `to`/`cc`/`bcc` (at most 50 recipients), `subject`, `text` and/or `html`. With `in_reply_to_uid` (and `in_reply_to_folder`) it sets In-Reply-To and References, defaults the recipient to the original's Reply-To or sender, prefixes "Re:" and marks the original `\Answered`. A copy goes to the Sent folder unless the provider files one itself (Gmail does) | write, open-world |

Moves use IMAP MOVE. A server without MOVE gets COPY, then the original is flagged `\Deleted` and removed with `UID EXPUNGE` (UIDPLUS), which touches only the moved messages; a server with neither MOVE nor UIDPLUS is refused, because its plain EXPUNGE would also remove messages another client marked as deleted. UIDs belong to one folder and change when a message moves. Bcc recipients are in the SMTP envelope only, never in the transmitted headers; the copy in Sent keeps the Bcc header so the sender can see it. Once SMTP has accepted a message the tool does not fail: a Sent copy that could not be filed is reported as a warning in the result, because sending again would deliver the mail twice.

Outgoing attachments are not supported yet.

## Settings (`config.email`)

| Key | Meaning |
|-----|---------|
| `imapHost`, `imapPort`, `imapSecurity` | IMAP server. Security `tls` (implicit TLS, port 993) or `starttls` (port 143, the upgrade is required, never optional); left out, the port decides. |
| `smtpHost`, `smtpPort`, `smtpSecurity` | SMTP server. `tls` on 465, `starttls` on 587. Without an SMTP host the connector reads but cannot send. |
| `fromAddress`, `fromName` | Sender of sent mail. Default: the username, when it is an address. |
| `sentFolder`, `draftsFolder`, `trashFolder` | Folders to use. Default: the ones the server marks with SPECIAL-USE (`\Sent`, `\Drafts`, `\Trash`), or recognised by name. |
| `saveSent` | `auto` (default: file a copy in Sent, except on Gmail), `always`, `never`. |
| `allowSelfSigned` | Self-hosted only: accept a certificate that is not from a public authority. |
| `toolPrefix` | Prefix of the built-in tool names. |

The login is stored encrypted in `authConfig` (`BASIC_AUTH`): `username`, `password`, and optionally `smtpUsername` / `smtpPassword` when sending uses a different login. The connector page never shows them; an empty field keeps the stored value.

The connector's base URL (`imaps://host:993`) is what the connector list shows; the engine reads `config.email`.

## How it connects

- Every tool call opens its own IMAP connection, does its work and logs out. Nothing stays connected between calls, there is no IDLE, and a changed password applies at once.
- 15 seconds to connect (DNS, TCP, TLS and greeting), 60 seconds without an answer, and a cap on how much one server response may make the backend hold in memory.
- Message bodies and attachments are downloaded part by part (`BODY.PEEK`, so reading does not mark a message as read); a 20 MB attachment is never loaded to read the text next to it.
- Credentials never reach a log line or an error message: the IMAP and SMTP clients' own logging is off, and every error is scrubbed of the passwords and of their AUTH PLAIN / LOGIN encodings before it leaves the engine.

## Cloud and self-hosted

| | AnythingMCP Cloud | Self-hosted |
|---|---|---|
| Mail server on a private, loopback or link-local address | Refused by the outbound SSRF guard | Refused by default; allowed once an administrator adds the host to the outbound allowlist (Admin → Settings, or `SSRF_ALLOWED_HOSTS`) |
| Encryption | SSL/TLS or STARTTLS only | Also plaintext, for a server on the internal network |
| Certificate | Must be valid for the host name | May be self-signed with "Accept self-signed certificate" |
| Ports | IMAP 993/143, SMTP 465/587/25/2525 | Any |

The guard resolves the host once and the connection goes to exactly the address it checked, with the host name kept for TLS (SNI and certificate check). Many hosting networks block outgoing port 25: use 465 or 587.

## Not yet

- OAuth sign-in (XOAUTH2) for Gmail and Microsoft 365. The engine has the extension point (`authConfig.mechanism`); until then Gmail works with an app password and Microsoft 365 through the Microsoft Outlook connector.
- Push notifications for new mail (IDLE). Tools run on demand only.
- Attachments on outgoing mail, and Gmail's own search syntax (`X-GM-RAW`).

## Tests

`packages/backend/src/connectors/engines/email.engine.spec.ts` covers the engine against a scripted client (criteria, truncation, attachment cap, reply headers, Sent rules, the SSRF guard on Cloud and self-hosted, scrubbed errors). `email.engine.integration.spec.ts` runs the same flows against a real IMAP server ([ImapKit](https://github.com/postalsys/imapkit), in memory) and SMTP server ([smtp-server](https://github.com/nodemailer/smtp-server)) inside Jest, including TLS with a self-signed certificate. `adapters/intl/imap-smtp.live.spec.ts` can check a real mailbox read-only when `RUN_IMAP_SMTP_LIVE=1` is set.

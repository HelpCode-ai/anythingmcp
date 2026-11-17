# Per-user sign-in for OAuth2 connectors

> Needs **AnythingMCP Enterprise**. Available on AnythingMCP Cloud and on
> self-hosted instances with an Enterprise licence key. The 30-day trial does
> not include it.

By default an OAuth2 connector is authorized **once**: whoever clicks
"Authorize with Provider" signs in, and every user of the workspace then calls
the provider with that one account. Everyone sees what that account can see.

With **per-user sign-in**, every user connects **their own** account. Each tool
call carries the token the provider issued to the caller, so the provider's own
permissions decide what each user sees and may change. This suits providers that
already govern access per user: a remote MCP server such as mfr's, or Microsoft
365, Google and similar APIs.

## Turning it on

1. Open the connector. It must use **OAuth2** with a browser sign-in
   (authorization code). API keys, passwords and the client-credentials grant
   stay shared: there is no user to sign in.
2. In the **Sign-in** card, the connector's owner or an admin clicks
   **Require each user to sign in (Enterprise)** and confirms.
3. Every user connects their own account: on the connector page in the
   dashboard (**Connect my account**), or on the connect page (below). Either
   way they then sign in at the provider with their own account.

Switching to per-user removes the authorization stored on the connector. The OAuth
client stays: the client ID and secret, and on MCP servers the dynamically
registered client. Switching back to a shared sign-in removes every user's own
sign-in, and the connector then needs one authorization of its own again.

## The connect page

Every per-user connector also has a connect page at
`<FRONTEND_URL>/auth/connect/<connector id>`. It is served by the backend next
to the sign-in page MCP clients open, so it works wherever MCP sign-in works,
also on a self-hosted server whose dashboard is not reachable from outside.
Send your team this link, or let the model hand it over: the error of a call
without a sign-in links to it.

On the page a user:

1. signs in to AnythingMCP, with the workspace's identity provider (Microsoft
   Entra ID or another OIDC provider set up under **Settings → Identity
   providers**), or with the dashboard session already open in that browser;
2. clicks **Connect my account** and signs in at the provider;
3. is back on the page, connected.

Without an identity provider (and on AnythingMCP Cloud) the page sends users to
the connector in the dashboard instead.

What the page guards:

- The sign-in there is valid for 15 minutes and for `/auth/connect` only. It
  is not a dashboard session. **Sign out everywhere** ends it.
- The tokens go to the user signed in on the page, and only in the browser that
  started the connection. A provider link forwarded to someone else, or opened
  in another browser, stores nothing.
- Before signing in, the page names no connector, so a link reveals nothing to
  someone outside the workspace.

Behind a reverse proxy, `/auth/` and `/api/mcp-oauth/` must reach the backend,
and so must the identity provider's redirect URI `<FRONTEND_URL>/auth/sso/callback`.
These are the same routes MCP sign-in and the connector's OAuth callback
already use.

## What each call does

- **The caller's own sign-in.** A call uses the token of the signed-in user who
  makes it, from an MCP client or from **Run Test** and **Test connection** in
  the dashboard. The connector's own token is never used, so a missing sign-in
  never falls back to someone else's.
- **Not connected yet.** The call fails before anything is sent. The error names
  the connector and links to its connect page, so the model can tell the user
  where to connect.
- **No signed-in user.** A call that does not come from a user fails the same
  way, for example a workspace API key or a job that runs on its own.
- **Response cache.** For tools with a response cache, entries are kept per user.
  One user's cached answer is never served to another.

## Expired or refused sign-ins

Tokens refresh automatically for each user, under that user's own refresh lock.
When the provider refuses a user's refresh token, for example after a password
change, a revocation or a long period of inactivity, the sign-in is marked
**Your sign-in expired** for that user only. That user gets one email, and their
calls fail at once with what to do. Other users are not affected. Connecting
again, on the connect page that the email links to or on the connector page,
clears it.

When the OAuth client itself stops working, for example because a client secret
expired, every user's sign-in fails. The connector's OAuth settings need
fixing, and each user then signs in again.

## Tools of an MCP connector

The tools of a per-user MCP connector are imported when users sign in, with the
first user's account and with each later sign-in. **Re-discover Tools** lists
them with your own sign-in. The remote server still checks every call against the
caller's own permissions.

## Connectors without a provider sign-in: per-user values

> A preview, off by default: set `USER_VARIABLE_CREDENTIALS=true` on a
> self-hosted server with an Enterprise licence. Not switched on for
> AnythingMCP Cloud yet. Everything is set through the API for now; the
> dashboard and the connect page get their forms in a later release, so the
> link in the "connect first" error does not open a form yet.

A connector that signs in with an API key, a token or a user name and password
has no provider sign-in to send each user through. There, per-user means every
user enters **their own values of some of the connector's variables**, for
example `ACME_API_KEY`, or the user name and password of a mail archive.

- **Which connectors.** REST, GraphQL, SOAP, OData, e-mail and MCP connectors
  whose sign-in is an API key (header or query), a bearer token, basic auth,
  WS-Security or none (a key in the address or the body). Not yet: database
  connectors, login-token, HMAC and OAuth 1.0a sign-ins, client certificates,
  and bearer tokens that are renewed in the background. File Search and
  connectors that receive webhooks stay shared: they work without a caller.
- **Switching.** `PATCH /api/connectors/:id/credential-scope` with
  `{ "credentialScope": "USER", "userVariables": ["ACME_API_KEY"] }`. The
  connector must use each variable as `{{NAME}}` somewhere (address, headers,
  sign-in or tools). The connection test is how each user's values are checked
  later, so it has to tell right from wrong first: it must pass with the
  connector's current values, and fail with made-up ones. A test that passes
  without the sign-in (a public health check, a WSDL anyone can read) is
  refused; set a health check path that needs the sign-in.
- **Only what signs a user in.** A per-user variable can sit in the sign-in,
  a header, the path of the address or a tool. It cannot be part of the
  server's address (scheme, host, port), of the connector's settings (mail
  hosts and ports, the MCP path) or the start of a tool's path: a call also
  carries what the connector shares, and no user may choose where that goes.
  Values with a line break or a control character are refused.
- **Afterwards.** The connector's own values of those variables stay empty,
  whatever is typed into them, and a sign-in field that refers to one cannot
  be overwritten with a fixed value. Switch back to shared to change that.
- **What the switch removes.** The connector's own values of those variables,
  everywhere they are stored. A call never falls back to them: a user who has
  not entered their own gets the "connect first" error with the link to the
  connect page, and nothing is sent.
- **Entering values.** `PUT /api/connectors/:id/my-credential` with
  `{ "variables": { "ACME_API_KEY": "…" } }`. The values are tried with the
  connection test and stored only when it passes. They are stored encrypted,
  per user, and never returned.
- **Back to shared.** Removes every user's values. The connector's own values
  of those variables are empty then and have to be entered again.

## API

| Method and path | Who | What |
|---|---|---|
| `PATCH /api/connectors/:id/credential-scope` `{ "credentialScope": "USER" \| "SHARED" }` | owner or admin | Switch the mode (USER needs Enterprise) |
| `POST /api/connectors/:id/oauth/authorize` | any member (per-user connectors) | Start your own sign-in |
| `PATCH /api/connectors/:id/credential-scope` `{ "credentialScope": "USER", "userVariables": ["NAME"] }` | owner or admin | Per-user values for a connector without a provider sign-in |
| `GET /api/connectors/:id/my-credential` | any member | Whether you are connected, and for per-user values which variables to enter; no token or value is returned |
| `PUT /api/connectors/:id/my-credential` `{ "variables": { "NAME": "value" } }` | any member (per-user values) | Enter your own values; stored only when the connection test passes |
| `DELETE /api/connectors/:id/my-credential` | any member | Disconnect your own account |
| `GET /auth/connect/:id` | anyone (HTML) | The connect page; signs the user in first |

Tokens are stored encrypted with `ENCRYPTION_KEY`, one row per user and
connector (`user_connector_credentials`). They are deleted with the user, the
connector or the workspace. Connector exports never include them.

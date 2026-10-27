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
3. Every user opens the connector and clicks **Connect my account**, then signs
   in at the provider with their own account.

Switching to per-user removes the authorization stored on the connector. The OAuth
client stays: the client ID and secret, and on MCP servers the dynamically
registered client. Switching back to a shared sign-in removes every user's own
sign-in, and the connector then needs one authorization of its own again.

## What each call does

- **The caller's own sign-in.** A call uses the token of the signed-in user who
  makes it, from an MCP client or from **Run Test** and **Test connection** in
  the dashboard. The connector's own token is never used, so a missing sign-in
  never falls back to someone else's.
- **Not connected yet.** The call fails before anything is sent. The error names
  the connector and links to its page, so the model can tell the user where to
  connect.
- **No signed-in user.** A call that does not come from a user fails the same
  way, for example a workspace API key or a job that runs on its own.
- **Response cache.** For tools with a response cache, entries are kept per user.
  One user's cached answer is never served to another.

## Expired or refused sign-ins

Tokens refresh automatically for each user, under that user's own refresh lock.
When the provider refuses a user's refresh token, for example after a password
change, a revocation or a long period of inactivity, the sign-in is marked
**Your sign-in expired** for that user only. That user gets one email, and their
calls fail at once with what to do. Other users are not affected. **Sign in
again** on the connector page clears it.

When the OAuth client itself stops working, for example because a client secret
expired, every user's sign-in fails. The connector's OAuth settings need
fixing, and each user then signs in again.

## Tools of an MCP connector

The tools of a per-user MCP connector are imported when users sign in, with the
first user's account and with each later sign-in. **Re-discover Tools** lists
them with your own sign-in. The remote server still checks every call against the
caller's own permissions.

## API

| Method and path | Who | What |
|---|---|---|
| `PATCH /api/connectors/:id/credential-scope` `{ "credentialScope": "USER" \| "SHARED" }` | owner or admin | Switch the mode (USER needs Enterprise) |
| `POST /api/connectors/:id/oauth/authorize` | any member (per-user connectors) | Start your own sign-in |
| `GET /api/connectors/:id/my-credential` | any member | Whether you are connected; no token is returned |
| `DELETE /api/connectors/:id/my-credential` | any member | Disconnect your own account |

Tokens are stored encrypted with `ENCRYPTION_KEY`, one row per user and
connector (`user_connector_credentials`). They are deleted with the user, the
connector or the workspace. Connector exports never include them.

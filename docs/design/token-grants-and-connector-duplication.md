# Design: tokens without a refresh token, and duplicating connectors and tools

Status: proposal, not implemented. This document collects two requests from custom REST connector users and the options for each, so the implementation can start from an agreed plan.

1. **Tokens that expire and come with no refresh token.** Some APIs issue a short-lived bearer token from their credentials (key and secret, or username and password) and expect the client to simply ask again when it expires. Datto RMM is a typical case: `POST /auth/oauth/token` with the OAuth2 *password* grant returns a token valid for 100 hours and no `refresh_token`. Keycloak-based APIs with the *client credentials* grant behave the same way (Cdiscount / Octopia: 2-hour tokens).
2. **Duplicating tools and connectors, and exporting or importing a single connector.** Users who build connectors by hand want to copy a tool inside a connector, copy a whole connector to trim it down into a second version, and move a connector between workspaces or instances without name clashes.

## Part 1: tokens without a refresh token

### What happens today

- **OAuth 2.0** (`OAuth2TokenService`) supports two grants:
  - `refresh_token`, the default: the authorization-code flow, then refreshes;
  - `client_credentials` (`authConfig.grant`).
- **With the password grant:** a token that was pasted or obtained once has no refresh token. When it expires, `getAccessToken` has nothing to send and throws `unauthorized` (oauth2-token.service.ts, the `grant !== 'client_credentials' && !stored` branch). The connector then stops working until someone pastes a new token. That is the failure users see after 100 hours.
- **`client_credentials`:** works in the engine, but cannot be chosen in the UI:
  - the OAuth2 forms in `app/connectors/new` and `app/connectors/[id]` have no grant field;
  - `PATCH :id/oauth-config` does not accept `grant`.
  - Only a full `authConfig` sent to `POST/PUT /api/connectors`, or a catalog adapter, can set it.
- **Login → Token (`LOGIN_TOKEN`):** can re-login on 401 or after a TTL, which is what these APIs need, with two limits:
  - It always sends `Content-Type: application/json`. Token endpoints that follow RFC 6749 expect `application/x-www-form-urlencoded`; Keycloak, for example, answers `Missing form parameter: grant_type`.
  - Overriding the content type with `authConfig.loginHeaders` works (axios then form-encodes the object body), but `loginHeaders` is not in the UI either.

### Options

**A. Add the OAuth2 `password` grant (RFC 6749 §4.3).**
- `authConfig.grant = 'password'` with `tokenUrl`, `username`, `password`, optional `clientId`/`clientSecret` (sent as HTTP Basic or in the body, following `tokenAuthMethod`) and `scope`.
- The token service treats it like `client_credentials`: fetch a token when none is cached or it is about to expire, and fetch again on a 401. Rotation is never involved, because nothing is refreshed.
- Datto RMM fits this exactly:
  - `tokenUrl` = `https://<platform>-api.centrastage.net/auth/oauth/token`;
  - username = API key, password = API secret;
  - Basic client `public-client:public`.
- Cost: small. It reuses the `client_credentials` path; the new parts are the form fields and the tests.

**B. Form-encoded body for Login → Token.**
- New field `authConfig.loginBodyEncoding: 'json' | 'form'` (default `json`), plus the existing `loginHeaders`, both exposed in the UI.
- Covers any "post credentials, read a token" endpoint, OAuth2 or not, including ones that need extra fields.
- Cost: small in the engine (set the header and serialise with `URLSearchParams`); a little more in the forms.

**C. Expose the grant in the OAuth2 forms.**
- A grant selector: *Authorization code* (today's flow, with Authorize with Provider), *Client credentials*, *Password*.
- It shows only the fields that grant needs and hides the authorize button for the two machine grants.
- `PATCH :id/oauth-config` accepts and validates `grant`.

**Recommendation:** C together with A. They are the standard OAuth2 way to describe these APIs, and users find them under the OAuth 2.0 option where they look first. Add B for the non-OAuth login endpoints. All three are independent and can ship separately.

### Tests to add

- Token service:
  - the password grant fetches a token, caches it, refetches near expiry and on a 401;
  - no refresh is attempted;
  - client credentials are sent as Basic or in the body.
- Login → Token:
  - `loginBodyEncoding: 'form'` sends `application/x-www-form-urlencoded` with the interpolated fields;
  - JSON stays the default.
- Forms:
  - the grant is saved and shown again on edit;
  - the authorize button is hidden for machine grants.

## Part 2: duplicating tools and connectors, per-connector export and import

### What exists today

- **No duplicate action** for a tool or a connector, in the UI or the API.
- **Workaround for a tool:** `POST /api/connectors/:id/tools` with a renamed copy works.
- **Pitfall:** the JSON import on a connector (`POST /api/connectors/:id/import`, `source: 'json'`) matches existing tools by operationId, then method and path, then name, and *updates* the match. A copy with a new name and the same endpoint renames the original instead of adding a second tool.
- **Export and import exist only for all connectors at once** (`GET /api/connectors/export-all`, `POST /api/connectors/import-all`, buttons on the Connectors page):
  - a connector whose name already exists is skipped;
  - clashing tool names inside a connector are skipped silently;
  - `authConfig`, `healthcheckPath`, `instructions`, tool `annotations` and `operationId` are not exported.

### A note on "the same auth parameters in every tool"

Part of the wish to duplicate comes from APIs that carry credentials as parameters, so every new tool needs the same values typed in again. The engine already covers this:
- connector environment variables are injected as parameter defaults (`ConnectorsService`, "Inject env vars as parameter defaults");
- `{{VAR}}` works in paths, query parameters, body mappings and templates.

Moving those values into connector variables, and out of each tool's parameter schema, removes the repetition and keeps credentials out of what the model sees. The tool editor should say so where parameters are defined. That is cheap, and worth doing whatever is decided below.

### Options

**D. Duplicate a tool.**
- `POST /api/connectors/:connectorId/tools/:toolId/duplicate`, optionally with a new name. The default name is `<name>_copy`, then `_copy2` and so on, kept unique within the connector.
- It copies the description, parameters, endpoint mapping, response mapping, annotations, role access and proxy setting.
- It does not copy invocation history or knowledge-graph data.
- UI: a "Duplicate" action in the tool list.

**E. Duplicate a connector.**
- `POST /api/connectors/:id/duplicate`, creating `<name> (copy)`.
- It copies the encrypted `authConfig`, env vars, headers and config as they are (same workspace, same encryption key), plus all tools.
- It does not copy MCP server assignments: a copy that appears on a server next to the original would publish duplicate tool names. It also does not copy OAuth tokens: the copy has to be authorized again, because sharing one refresh token between two connectors makes rotating refresh tokens revoke each other.
- Catalog connectors keep `adapterSlug`, so catalog updates still apply to the copy.

**F. Export and import a single connector.**
- `GET /api/connectors/:id/export` returns the same format as one entry of `export-all`, extended with:
  - the non-secret `authConfig` keys (header name, login URL, token path, TTL, grant, token URL, scopes);
  - `healthcheckPath`, `instructions`, and tool `annotations` and `operationId`.
- Secrets stay out, as in `export-all` today (admins may include env-var secrets, as now).
- `POST /api/connectors/import` takes one or more connectors and a collision policy per connector and per tool:
  - `skip`, today's behaviour and the default;
  - `rename`, which adds a suffix;
  - `replace`, which updates the existing connector or tool matched by name and keeps its credentials.
- The answer lists what was created, renamed, replaced or skipped.
- `import-all` keeps its current behaviour and gains the same optional policy.

**Recommendation:** D and E first. They are small, self-contained and answer the daily need. F builds on the non-secret auth read described below and can follow.

## Related fix: the edit form loses authentication settings

- **Why the fields look empty:** the connector API never returns `authConfig` (`toPublicConnector` drops it). The edit form therefore shows the API-key header name and the Login → Token fields (login URL, body, token path, TTL) empty or at their defaults.
- **When settings are actually lost:** only when the user retypes the secret. The form then sends a complete new `authConfig` built from those empty fields, and `PUT /api/connectors/:id` replaces the stored one without merging. Saving without retyping the secret leaves `authConfig` untouched.
- **Fix:**
  1. return the non-secret auth keys (the same list as F), for example as `publicAuthConfig`;
  2. when the auth type is unchanged, merge the incoming `authConfig` into the stored one, keeping a secret the form sends empty;
  3. fill the edit form from `publicAuthConfig`.

  Step 1 is shared with F, so the two belong together.

## Suggested order of work

1. Edit-form fix (non-secret auth read + merge on update).
2. OAuth2 grant selector + `password` grant (C + A).
3. Duplicate tool and duplicate connector (D + E).
4. Form-encoded Login → Token body and login headers in the UI (B).
5. Per-connector export/import with collision policy (F).
6. Hint in the tool editor about connector variables for shared parameters.

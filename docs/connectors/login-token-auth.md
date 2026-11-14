# LOGIN_TOKEN Authentication

> Reference for adapter authors building connectors against APIs that:
>
> - Issue a long-lived bearer token in exchange for a credentials POST
> - Optionally require the password to be bcrypt-hashed client-side with a salt fetched from the remote service (Sorare-style)
> - Want automatic token caching, proactive refresh, and re-login on 401 with no per-call boilerplate

[Back to README](../../README.md) | [Tool Definition](../tool-definition.md)

---

## When to use `LOGIN_TOKEN`

| Scenario | Use |
|---|---|
| Static API key in a header | `API_KEY` |
| User-provided bearer JWT, no rotation | `BEARER_TOKEN` |
| HTTP Basic | `BASIC_AUTH` |
| OAuth2 Authorization Code / Client Credentials with refresh tokens | `OAUTH2` |
| **POST `{username, password}` → receive bearer good for hours/days** | **`LOGIN_TOKEN`** |
| **Client-side bcrypt against a per-account salt before login** | **`LOGIN_TOKEN`** |

If your provider already speaks OAuth2, prefer `OAUTH2` — it has standardised refresh, scope, and PKCE handling.

---

## How the engine flows

```
┌─────────────────────────────────────────────────────────────────────┐
│ first tool call                                                     │
└─────────────────────────────────────────────────────────────────────┘
    │
    ├─ cache hit (memory) → use cached token ──────────────────────┐
    │                                                              │
    ├─ cache miss → DB lookup ─ row present, not near expiry ──────┤
    │                                                              │
    └─ cache miss + DB miss / expired:                             │
         1. resolveSalt()      (saltSource.fetch OR static)        │
         2. preparePassword()  (bcrypt OR passthrough)             │
         3. POST loginBody     (interpolate ${...} placeholders)   │
         4. extract token + expiry                                 │
         5. cache in-memory + upsert connector_auth_cache row      │
                                                                   │
                                                          ┌────────┘
                                                          ▼
                                      inject Authorization header (+ extraHeaders)
                                                          ▼
                                      execute the tool call ─────► API
                                                          │
                                                          ▼
                                              response 401? ──► forceRelogin() + retry once
```

With `tokenPlacement: "body"` the token is rendered into the tool's body instead of a header, and with `refreshOnBody401` a refused token reported in the response body triggers the same re-login (see [XML logins and a token in the request body](#xml-logins-and-a-token-in-the-request-body)).

The token cache is keyed by `connectorId` (when available) or by `loginUrl|username`. A per-key mutex prevents concurrent refresh storms.

---

## `authConfig` field reference

```jsonc
{
  // ─── Login endpoint ────────────────────────────────────────────
  "loginUrl": "https://api.example.com/graphql",
  "loginMethod": "POST",                     // GET | POST (default POST)
  "loginHeaders": { "X-App": "anythingmcp" }, // static headers for the login call
  "loginBasicAuth": true,                    // optional: send Authorization: Basic base64(username:password)
                                             // on the login call only (Wazuh). The password is then not
                                             // offered to templates, no body is sent without loginBody, and
                                             // an Authorization in loginHeaders is refused, as are signedJwt
                                             // and bcrypt passwordHashing.

  // ─── Body: prefer structured `loginBody` (recursive ${name} substitution) ─
  "loginBody": {
    "query": "mutation Login($email: String!, $password: String!) { signIn(input: {email: $email, password: $password}) { token } }",
    "variables": {
      "email": "${username}",
      "password": "${passwordHashed}"
    }
  },
  // …or a raw string template (only for very simple JSON bodies):
  "loginBodyTemplate": "{\"u\":\"${username}\",\"p\":\"${passwordHashed}\"}",
  // …or, for an XML API, the document as a string (see "XML logins" below):
  "loginBodyFormat": "xml",                  // optional: a string loginBody is XML, its values are XML-escaped
  "loginResponseFormat": "xml",              // optional: parse an XML login answer so the paths below address it

  // ─── Credentials & client identity ─────────────────────────────
  "username": "{{SERVICE_EMAIL}}",
  "password": "{{SERVICE_PASSWORD}}",
  "aud":      "{{SERVICE_AUD}}",     // optional; exposed in ${aud} for templates/headers
  "otp":      "{{SERVICE_OTP}}",     // optional 2FA code

  // ─── Client-side password preprocessing ────────────────────────
  "passwordHashing": {
    "scheme": "bcrypt",              // bcrypt | none
    "saltSource": {                  // required when scheme=bcrypt
      "type": "fetch",               // fetch | static
      "method": "GET",
      "url": "https://api.example.com/api/v1/users/${username}",
      "headers": { },
      "responsePath": "salt",        // JSON path to salt in the response
      "value": "$2a$11$..."          // only when type=static
    },
    "outputParam": "passwordHashed"  // name exposed to the body template (default: passwordHashed)
  },

  // ─── Or: a JWT signed with the account's private key (no password) ─
  "signedJwt": {
    "privateKey": "{{SERVICE_PRIVATE_KEY}}", // PEM, PKCS#1 / PKCS#8 / SEC1
    "algorithm":  "RS256",                   // RS256 (default) | RS384 | RS512 | PS256 | ES256 | ES384
    "claims":     { "sub": "{{SERVICE_KEY_ID}}" },
    "keyId":      "…",                       // optional `kid` header
    "ttlSeconds": 300,                       // optional; adds exp = iat + ttlSeconds
    "outputParam": "signedJwt"               // name exposed to the body template (default: signedJwt)
  },

  // ─── Where to find the token & expiry in the login response ────
  "tokenJsonPath":  "data.signIn.jwtToken.token",   // or a list, see below
  "expiryJsonPath": "data.signIn.jwtToken.expiredAt",
  "audJsonPath":    "data.signIn.jwtToken.aud",      // optional — overrides authConfig.aud
  "expiryFormat":   "iso8601",                       // iso8601 | unix | ttl_seconds
  "tokenTTLSeconds": 2592000,                        // fallback when expiry is absent (30 days)

  // ─── Or: the session is a cookie the login sets ────────────────
  "tokenSource": "cookie",                           // body (default) | cookie | header
  "cookieName":  "B1SESSION",                        // the cookie whose value is ${token}
  "cookieMode":  "single",                           // single (default) | all — see below

  // ─── Or: the token comes back in a response header ─────────────
  "tokenSource": "header",                           // body (default) | cookie | header
  "tokenHeaderName": "access_token",                 // the response header whose value is ${token}

  // ─── Re-login policy ───────────────────────────────────────────
  "refreshOn401": true,                              // re-login on a 401 and retry once (default true)
  "refreshOnBody401": false,                         // also when the body reports the refused token (default false, see below)
  "proactiveRefreshSeconds": 86400,                  // re-login when this much remains (default 24 h)

  // ─── Header injection for downstream tool calls ────────────────
  "tokenPlacement": "header",                        // header (default) | body: no token header, ${loginToken} in the bodyTemplate
  "headerName":     "Authorization",                 // default Authorization
  "headerTemplate": "Bearer ${token}",               // default "Bearer ${token}"
  "extraHeaders": {
    "JWT-AUD": "${aud}"
  }
}
```

### Several candidate token paths

When the vendor does not document the login answer, `tokenJsonPath` can be a
list of paths, tried in order; the first that holds a non-empty string is the
token. `"."` takes the whole body, for a login that answers with a bare
string. A login that finds none fails with every path named (or with the
service's own refusal message, when the body carries one). A single string
works as before.

```json
"tokenJsonPath": ["AuthenticationResult.IdToken", "IdToken", "idToken", "data.idToken", "token", "."]
```

### Placeholders available in templates

The placeholders below are substituted by the engine when rendering `loginBody` / `loginBodyTemplate` and the salt-source URL:

| Placeholder | Source |
|---|---|
| `${username}` | `authConfig.username` |
| `${password}` | `authConfig.password` (plain, **before** hashing) |
| `${passwordHashed}` | output of the password preprocessor (renamed via `outputParam`) |
| `${aud}` | `authConfig.aud` |
| `${otp}` | `authConfig.otp` |
| `${signedJwt}` | a JWT signed for this login (see below; renamed via `outputParam`) |

In `headerTemplate` and `extraHeaders`, only `${token}`, `${aud}` and `${uuid}` are available. `${token}` and `${aud}` refer to the issued token, not the credentials. `${uuid}` is a new random UUID for every API request (the same value wherever it appears in that request), for APIs that want a unique request or correlation id on each call. In `loginHeaders`, `${uuid}` is the only placeholder and gives each login its own UUID.

With `tokenPlacement: "body"`, a tool's `endpointMapping.bodyTemplate` has one more placeholder, `${loginToken}`: the issued token (see [XML logins and a token in the request body](#xml-logins-and-a-token-in-the-request-body)).

A `loginBody` that is a string is sent as is, with its placeholders filled in (XML-escaped with `loginBodyFormat: "xml"`). Together with `"Content-Type": "application/x-www-form-urlencoded"` in `loginHeaders` that covers OAuth-style token endpoints which take a form body, such as Walmart's client-credentials call (`"loginBody": "grant_type=client_credentials"` with `loginBasicAuth: true`).

### XML logins and a token in the request body

Some APIs speak XML from the login on and never use an `Authorization` header:
Fnac Darty's marketplace API takes an XML document with a partner id, a shop id
and a key at `/auth`, answers `<auth_response><token>…</token><validity>…</validity></auth_response>`,
and expects the token as an attribute of the root element of every later
request. Four fields cover this. Each is opt-in, and a connector without them
behaves exactly as before.

```json
"authConfig": {
  "loginUrl": "https://api.example.com/auth",
  "loginBodyFormat": "xml",
  "loginBody": "<auth xmlns=\"urn:example\"><partner_id>${username}</partner_id><shop_id>${aud}</shop_id><key>${password}</key></auth>",
  "loginHeaders": { "Content-Type": "text/xml; charset=utf-8" },
  "username": "{{PARTNER_ID}}",
  "password": "{{API_KEY}}",
  "aud": "{{SHOP_ID}}",
  "loginResponseFormat": "xml",
  "tokenJsonPath": "auth_response.token",
  "expiryJsonPath": "auth_response.validity",
  "expiryFormat": "iso8601",
  "tokenPlacement": "body",
  "refreshOnBody401": true
}
```

- **`loginBodyFormat: "xml"`**: a string `loginBody` is an XML document. The
  values `${username}`, `${password}`, `${aud}` and the other login
  placeholders insert are XML-escaped (`&` `<` `>` `"` `'`), and the request is
  labelled `application/xml; charset=utf-8` unless `loginHeaders` set a
  Content-Type. Without the field a string `loginBody` is sent as before: the
  values go in as they are and the request is labelled `application/json`
  unless `loginHeaders` say otherwise. The field has no effect on a structured
  `loginBody` or on `loginBodyTemplate`.
- **`loginResponseFormat: "xml"`**: a login answer that is a string and is
  declared XML (`text/xml`, `application/xml`, `…+xml`), or starts with `<`,
  is parsed with the parser the REST engine uses for XML answers: attributes
  sit next to child elements without a prefix, namespace prefixes are dropped
  and every value stays a string. `tokenJsonPath`, `expiryJsonPath` and
  `audJsonPath` then address the document by element name, root element
  included (`auth_response.token`). When the answer carries no token, the text
  of its first `<error>` element is reported as the service's refusal, with the
  error's `code` attribute in front. Anything that is not an XML document is
  read as it arrived.
- **`tokenPlacement: "body"`**: REST tool calls send no token header
  (`headerName` and `headerTemplate` are not used; `extraHeaders` still are).
  The token is the placeholder `${loginToken}` in a tool's
  `endpointMapping.bodyTemplate`: XML-escaped with `bodyEncoding: "xml"`,
  JSON-escaped in a JSON template. The engine's value always wins: a tool
  argument named `loginToken` cannot replace it. A body that carries the token
  is not sent again to another origin after a redirect. Fixed values the body
  needs next to the token (a partner id, a shop id) are ordinary connector
  variables: `{{PARTNER_ID}}` in the template.

  ```json
  "endpointMapping": {
    "method": "POST",
    "path": "/offers_query",
    "bodyEncoding": "xml",
    "bodyTemplate": "<offers_query partner_id=\"{{PARTNER_ID}}\" shop_id=\"{{SHOP_ID}}\" token=\"${loginToken}\"><paging>${page}</paging></offers_query>"
  }
  ```

- **`refreshOnBody401: true`**: an API of this kind also reports an expired
  token in the body rather than with HTTP 401. Describe the error in
  `connector.config.errorWhen` (see
  [Errors inside a 200 response](../tool-definition.md#errors-inside-a-200-response))
  with `status: 401`; when such a rule matches a 2xx answer, or the body of an
  HTTP error answer (Fnac's test platform refuses a wrong key with HTTP 400 and
  the XML error in the body), the engine logs in again and repeats the call
  once, with the new token in the header or in the body. A second refusal is
  reported as it is. Without the field a mapped 401 is reported and nothing is
  retried, as before.

  ```json
  "config": {
    "errorWhen": [
      { "path": "offers_query_response.error.code", "in": ["ERR_098", "ERR_102"], "messagePath": "offers_query_response.error.#text", "status": 401 }
    ]
  }
  ```

  An `<error code="ERR_098">text</error>` element parses to
  `{ "code": "ERR_098", "#text": "text" }`, hence the `#text` path.

`tokenPlacement: "body"` and `refreshOnBody401` apply to REST connectors.
`scripts/validate-adapters.mjs` checks the combinations (rule
`login-token-xml`): a `${loginToken}` without `tokenPlacement: "body"`, a body
placement no template uses, a `refreshOnBody401` without a 401 rule.

Optional elements of an XML request are left out with template blocks, see
[XML bodies](../tool-definition.md#xml-bodies).

### Signed JWT logins

Some APIs take no password: the client signs a short JWT with the private key
of a service account and posts it to the login endpoint (noon's Partner API:
RS256, `sub` = the key id, then the session comes back as cookies). With
`signedJwt` set, `username` and `password` are not required, and every login
signs a new token: `iat` is the current time in whole seconds, `jti` a random
UUID, then the configured `claims`; `exp` is added only when `ttlSeconds` is
set. A claim whose `{{VARIABLE}}` has no value stops the login with an error
that names it. The key is read as for OAuth2 `private_key_jwt` client
assertions: a PEM pasted on one line or with literal `\n` works, an encrypted
key is refused, and no error message contains key material.

```json
"loginBody": { "token": "${signedJwt}", "default_project_code": "{{NOON_PROJECT_CODE}}" },
"signedJwt": { "privateKey": "{{NOON_PRIVATE_KEY}}", "algorithm": "RS256", "claims": { "sub": "{{NOON_KEY_ID}}" } },
"tokenSource": "cookie",
"cookieMode": "all"
```

### Expiry formats

| `expiryFormat` | Value at `expiryJsonPath` |
|---|---|
| `iso8601` *(default)* | `"2026-06-17T08:34:21Z"` |
| `unix` | Seconds (≤1e12) or milliseconds since epoch |
| `ttl_seconds` | Lifetime in seconds from now |

If `expiryJsonPath` is missing or unresolvable, the engine falls back to `tokenTTLSeconds` (default 30 days).

### Session cookies

With `"tokenSource": "cookie"` the token is read from the login response's
`Set-Cookie` headers instead of its body.

- `"cookieMode": "single"` (default): `${token}` is the value of the cookie
  named `cookieName`, so the header is written as
  `"headerName": "Cookie", "headerTemplate": "B1SESSION=${token}"` (SAP
  Business One Service Layer).
- `"cookieMode": "all"`: `${token}` is every cookie the login set, already
  formatted as `name=value; name2=value2`, so the header is
  `"headerName": "Cookie", "headerTemplate": "${token}"`. Use it when the
  login sets more than one cookie the API needs, typically a session cookie
  plus a load-balancer cookie that pins the session to one node (SAP
  Signavio). Attributes are dropped, a cookie set twice keeps its last value,
  and a cookie the response deletes (empty value or `Max-Age` of 0 or less)
  is left out. `cookieName` is optional here; when set, the login fails unless
  that cookie is among them.

The body can still supply `${aud}` through `audJsonPath` (`"."` takes the
whole body, for logins that answer with a bare token string).

### Token in a response header

With `"tokenSource": "header"` the token is the value of the login response's
header named `tokenHeaderName`, and the body is not read for it, so
`tokenJsonPath` is not needed. Ceneo's token call works this way: a `GET` with
the API key in `Authorization: Basic <key>` answers an empty body and the
headers `access_token`, `expires_in` and `token_type`.

```json
"loginUrl": "https://developers.ceneo.pl/AuthorizationService.svc/GetToken?grantType='client_credentials'",
"loginMethod": "GET",
"loginHeaders": { "Authorization": "Basic {{CENEO_API_KEY}}" },
"loginBody": {},
"username": "{{CENEO_API_KEY}}",
"password": "{{CENEO_API_KEY}}",
"tokenSource": "header",
"tokenHeaderName": "access_token",
"tokenTTLSeconds": 900,
"proactiveRefreshSeconds": 120
```

- The header name is matched without regard to case (`access_token`,
  `Access_Token` and `ACCESS_TOKEN` are the same header). White space around
  the value is dropped.
- The login fails with `header "<name>" not found in the login response
  headers` when the response has no such header or an empty one. A
  `tokenSource` of `header` without `tokenHeaderName` is refused before any
  request is sent, and `scripts/validate-adapters.mjs` reports it (rule
  `login-token-source`).
- The expiry is not read from a header: set `tokenTTLSeconds` to the token's
  lifetime (900 for Ceneo's 15 minutes), or `expiryJsonPath` when the body
  carries it.
- `username` and `password` are still required. A login that only sends a key
  in `loginHeaders` sets both to that key and `"loginBody": {}`, so nothing
  but the header travels (a `GET` login sends `loginBody` as query
  parameters, and without a `loginBody` the credentials themselves).

---

## Security notes

- **Private keys never leave the server.** With `signedJwt`, only the signed token is sent; the key stays in encrypted storage like a password.
- **Plain passwords never leave the server.** Only the bcrypt hash is sent over the wire; the plain password lives only in encrypted `authConfig` storage.
- The encrypted `authConfig` is decrypted in-process at request time and never logged.
- Tokens persisted in `connector_auth_cache` are encrypted with the same AES-256-GCM key (`ENCRYPTION_KEY` env var).
- The salt-fetch and login URLs are passed through the SSRF guard (`assertSafeOutboundUrl`) before each request — they cannot point to private addresses.
- `${...}` placeholders are substituted as exact values, not eval'd; prototype-pollution keys (`__proto__`, `constructor`, `prototype`) are rejected by the raw-string renderer.

---

## End-to-end example: Sorare

See [`packages/backend/src/adapters/intl/sorare.json`](../../packages/backend/src/adapters/intl/sorare.json) for a full production adapter using this auth type — including a GraphQL `signIn` mutation, bcrypt salt fetched from `/api/v1/users/{email}`, 30-day JWT caching, and an `extraHeaders` entry for Sorare's required `JWT-AUD` header.

[Back to README](../../README.md) | [Tool Definition](../tool-definition.md)

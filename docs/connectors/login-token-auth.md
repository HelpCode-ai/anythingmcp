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

The token cache is keyed by `connectorId` (when available) or by `loginUrl|username`. A per-key mutex prevents concurrent refresh storms.

---

## `authConfig` field reference

```jsonc
{
  // ─── Login endpoint ────────────────────────────────────────────
  "loginUrl": "https://api.example.com/graphql",
  "loginMethod": "POST",                     // GET | POST (default POST)
  "loginHeaders": { "X-App": "anythingmcp" }, // static headers for the login call

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
  "tokenJsonPath":  "data.signIn.jwtToken.token",
  "expiryJsonPath": "data.signIn.jwtToken.expiredAt",
  "audJsonPath":    "data.signIn.jwtToken.aud",      // optional — overrides authConfig.aud
  "expiryFormat":   "iso8601",                       // iso8601 | unix | ttl_seconds
  "tokenTTLSeconds": 2592000,                        // fallback when expiry is absent (30 days)

  // ─── Or: the session is a cookie the login sets ────────────────
  "tokenSource": "cookie",                           // body (default) | cookie
  "cookieName":  "B1SESSION",                        // the cookie whose value is ${token}
  "cookieMode":  "single",                           // single (default) | all — see below

  // ─── Re-login policy ───────────────────────────────────────────
  "refreshOn401": true,                              // re-login on a 401 and retry once (default true)
  "proactiveRefreshSeconds": 86400,                  // re-login when this much remains (default 24 h)

  // ─── Header injection for downstream tool calls ────────────────
  "headerName":     "Authorization",                 // default Authorization
  "headerTemplate": "Bearer ${token}",               // default "Bearer ${token}"
  "extraHeaders": {
    "JWT-AUD": "${aud}"
  }
}
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

In `headerTemplate` and `extraHeaders`, only `${token}` and `${aud}` are available (these refer to the issued token, not the credentials).

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

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

  // ─── Where to find the token & expiry in the login response ────
  "tokenJsonPath":  "data.signIn.jwtToken.token",
  "expiryJsonPath": "data.signIn.jwtToken.expiredAt",
  "audJsonPath":    "data.signIn.jwtToken.aud",      // optional — overrides authConfig.aud
  "expiryFormat":   "iso8601",                       // iso8601 | unix | ttl_seconds
  "tokenTTLSeconds": 2592000,                        // fallback when expiry is absent (30 days)

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

In `headerTemplate` and `extraHeaders`, only `${token}` and `${aud}` are available (these refer to the issued token, not the credentials).

### Expiry formats

| `expiryFormat` | Value at `expiryJsonPath` |
|---|---|
| `iso8601` *(default)* | `"2026-06-17T08:34:21Z"` |
| `unix` | Seconds (≤1e12) or milliseconds since epoch |
| `ttl_seconds` | Lifetime in seconds from now |

If `expiryJsonPath` is missing or unresolvable, the engine falls back to `tokenTTLSeconds` (default 30 days).

---

## Security notes

- **Plain passwords never leave the server.** Only the bcrypt hash is sent over the wire; the plain password lives only in encrypted `authConfig` storage.
- The encrypted `authConfig` is decrypted in-process at request time and never logged.
- Tokens persisted in `connector_auth_cache` are encrypted with the same AES-256-GCM key (`ENCRYPTION_KEY` env var).
- The salt-fetch and login URLs are passed through the SSRF guard (`assertSafeOutboundUrl`) before each request — they cannot point to private addresses.
- `${...}` placeholders are substituted as exact values, not eval'd; prototype-pollution keys (`__proto__`, `constructor`, `prototype`) are rejected by the raw-string renderer.

---

## End-to-end example: Sorare

See [`packages/backend/src/adapters/intl/sorare.json`](../../packages/backend/src/adapters/intl/sorare.json) for a full production adapter using this auth type — including a GraphQL `signIn` mutation, bcrypt salt fetched from `/api/v1/users/{email}`, 30-day JWT caching, and an `extraHeaders` entry for Sorare's required `JWT-AUD` header.

[Back to README](../../README.md) | [Tool Definition](../tool-definition.md)

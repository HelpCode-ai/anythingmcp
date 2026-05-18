# Connect Sorare to AnythingMCP Cloud — managed MCP server for the Sorare GraphQL API

**Keywords:** connect sorare to cloud · sorare cloud mcp · sorare anythingmcp cloud · sorare managed mcp · sorare hosted mcp · sorare api saas · sorare claude cloud · sorare chatgpt cloud · sorare opencloud

> Use [`cloud.anythingmcp.com`](https://cloud.anythingmcp.com) as a **managed** MCP server for the [Sorare GraphQL API](https://github.com/sorare/api). Zero infrastructure on your side — sign up, install the adapter from the catalog, paste your Sorare email + password, mint an MCP API key, point any AI client at the cloud endpoint. The same bcrypt + 30-day JWT handling is baked in.

Other guides in this directory:

- [Sorare to MCP — main hub](./sorare-to-mcp.md)
- [Connect Sorare to Claude](./connect-sorare-to-claude.md)
- [Connect Sorare to ChatGPT](./connect-sorare-to-chatgpt.md)
- [Connect Sorare to OpenClaw](./connect-sorare-to-openclaw.md)

---

## Why the cloud path

| | Self-hosted | AnythingMCP Cloud |
|---|---|---|
| Setup | `git clone` + Docker + Postgres + Redis | sign up, paste credentials |
| ChatGPT can reach it | only via Cloudflare Tunnel / ngrok | yes, native HTTPS |
| Updates | `docker compose pull && up -d` | automatic, deployed on every merge to `main` |
| Where the Sorare JWT lives | encrypted in your local Postgres | encrypted in the managed Postgres (AES-256-GCM) |
| Cost | hosting only | managed pricing |

Pick the cloud if you want ChatGPT / Claude / OpenClaw to "just work" from any device, without exposing localhost to the internet. Pick self-hosted if you want the JWT and the bcrypt hash to never leave your hardware (see the [OpenClaw guide](./connect-sorare-to-openclaw.md) for a fully-local setup).

---

## Step 1 — Sign in on `cloud.anythingmcp.com`

1. Go to [`https://cloud.anythingmcp.com`](https://cloud.anythingmcp.com).
2. Register or sign in. The first user in an organisation becomes the admin.

---

## Step 2 — Install the Sorare adapter from the catalog

1. Open `https://cloud.anythingmcp.com/connectors`.
2. Click **Add connector → from catalog → Sorare Fantasy Football** (it's in the **Featured** rail because the adapter is marked `featured: true, priority: 100`).
3. Fill in:

| Field | Value |
|---|---|
| `SORARE_EMAIL` | your Sorare account email |
| `SORARE_PASSWORD` | your plain password (encrypted at rest with AES-256-GCM; only the bcrypt hash leaves the server) |

There is **no AUD field** — the adapter hardcodes the JWT audience to `anythingmcp` so you don't pick one.

4. Click **Install**. The 18 Sorare tools are now wired up.

> 💡 For headless / agent use we strongly recommend a **dedicated read-only Sorare account with 2FA disabled**. The `signIn` mutation refuses requests without a fresh OTP and there's no clean way to rotate OTPs from a server.

---

## Step 3 — Mint an MCP API key and pick your client

Under **Profile → MCP API Keys → New Key**, generate a key labeled by client (`claude-desktop`, `chatgpt-team`, `openclaw-laptop`, …).

The cloud MCP endpoint is:

```
https://cloud.anythingmcp.com/mcp
```

With the header:

```
Authorization: Bearer YOUR_MCP_API_KEY
```

### Hooking it up to clients

- **Claude Desktop / Claude Code** → see [`connect-sorare-to-claude.md`](./connect-sorare-to-claude.md). Swap the local `http://localhost:4000/mcp` URL for the cloud URL.
- **ChatGPT** → see [`connect-sorare-to-chatgpt.md`](./connect-sorare-to-chatgpt.md). The cloud URL is already public HTTPS, so no Cloudflare Tunnel needed.
- **OpenClaw** → see [`connect-sorare-to-openclaw.md`](./connect-sorare-to-openclaw.md). Replace the localhost URL in the `openclaw mcp set` payload.

---

## The 18 tools you get

| Group | Tools |
|---|---|
| **Identity / wallet** | `sorare_current_user`, `sorare_wallet_balance`, `sorare_my_trophies_summary`, `sorare_user_by_slug` |
| **Cards** | `sorare_list_my_cards`, `sorare_get_card_by_slug`, `sorare_list_player_cards` |
| **Players** | `sorare_search_player`, `sorare_player_recent_scores`, `sorare_player_floor_price` |
| **Market** | `sorare_live_sale_offers`, `sorare_token_prices`, `sorare_get_auction`, `sorare_get_lineup` |
| **Generic GraphQL escape hatch** | `sorare_graphql_schema_url`, `sorare_graphql_schema`, `sorare_graphql_query`, `sorare_graphql_mutation`, `sorare_graphql_subscription` |

Full field reference and pricing conventions: [`sorare-to-mcp.md`](./sorare-to-mcp.md).

---

## What's hosted vs what's local

- **Hosted in the cloud:** the bcrypt-hashed login flow, the JWT cache, the GraphQL schema cache, the per-tool routing.
- **Stays at the upstream:** the actual GraphQL execution hits `https://api.sorare.com/graphql` from the cloud server (not from your client).
- **Your client never gets your Sorare password.** It only gets MCP tool responses.

---

## FAQ

**How is my Sorare password protected on the cloud?**
Encrypted at rest in the `authConfig` blob using AES-256-GCM with a server-side `ENCRYPTION_KEY` env var. Only the bcrypt hash crosses the wire on `signIn`, never the plain password.

**Can I rotate my MCP API keys without breaking the Sorare auth?**
Yes — MCP API keys and Sorare credentials are separate. Revoke an MCP key from **Profile → MCP API Keys** without touching the adapter.

**Does the cloud cache the same JWT across all my MCP keys?**
Yes. The JWT lives once per connector in the encrypted `connector_auth_cache` table; all your MCP keys reuse it. Re-issued 24 h before expiry and on any 401.

**Can I uninstall the adapter and start over?**
Yes. **Connectors → Sorare → Uninstall** wipes the encrypted credentials and the cached JWT. You can reinstall any time.

**Is the cloud version of the catalog kept in sync with the open-source repo?**
Yes — the `deploy-cloud.yml` GitHub Actions workflow rebuilds the image from `main` on every merge and rolls it out to the droplet. Sorare's 18-tool surface is identical on cloud and self-hosted.

---

## Links

- [Sorare to MCP — main hub](./sorare-to-mcp.md)
- [AnythingMCP repo](https://github.com/HelpCode-ai/anythingmcp)
- [AnythingMCP cloud](https://cloud.anythingmcp.com)
- [Sorare API official repo](https://github.com/sorare/api)
- [LOGIN_TOKEN auth reference](../connectors/login-token-auth.md)

<p align="center">
  <img src="../assets/icons/sorare.svg" alt="Sorare" width="220" />
</p>

> 💡 **No install? Use [cloud.anythingmcp.com](https://cloud.anythingmcp.com) directly.** Sign in, click **Connectors → Sorare**, paste your Sorare email + password, mint an MCP API key — done. No Docker, no `git clone`, no local server to run. You can skip the local-install steps below and jump straight to the client-wiring section.

# Connect Sorare to OpenClaw — self-hosted AI assistant + NFT fantasy football

**Keywords:** connect sorare to openclaw · sorare openclaw · sorare openclaw mcp · sorare self-hosted ai · openclaw mcp connector · openclaw graphql · sorare local ai · fantasy football openclaw

> Add the [Sorare GraphQL API](https://github.com/sorare/api) to **[OpenClaw](https://openclaw.ai/)** — the open-source local AI assistant — via an MCP (Model Context Protocol) server published by [AnythingMCP](https://github.com/HelpCode-ai/anythingmcp). End-to-end private: your password and the issued JWT never leave your network.

Other guides in this directory:

- [Sorare to MCP — main hub](./sorare-to-mcp.md)
- [Connect Sorare to Claude](./connect-sorare-to-claude.md)
- [Connect Sorare to ChatGPT](./connect-sorare-to-chatgpt.md)
- [Connect Sorare to GitHub Copilot](./connect-sorare-to-copilot.md)
- [Connect Sorare to AnythingMCP Cloud](./connect-sorare-to-cloud.md)

---

## Why OpenClaw + Sorare + AnythingMCP

- **OpenClaw** runs locally. It supports streamable-HTTP MCP servers via `openclaw mcp set` ([CLI reference](https://docs.openclaw.ai/cli/mcp.md)).
- **AnythingMCP** wraps Sorare's GraphQL API as an MCP server. The bcrypt + 30-day-JWT handshake the Sorare API requires is fully managed.
- Run both on your machine and your Sorare credentials, the bcrypt hash, and the JWT all stay on your hardware. No SaaS dependency, no public exposure required.

---

## Prerequisites

- OpenClaw installed (`brew install openclaw` or follow [docs.openclaw.ai/getting-started](https://docs.openclaw.ai/getting-started)).
- AnythingMCP running locally: `git clone … && ./setup.sh && docker compose up -d`.
- A Sorare account (https://sorare.com). For headless / agent use, create a dedicated **read-only account with 2FA disabled**.

---

## Step 1 — Install the Sorare adapter

```bash
git clone https://github.com/HelpCode-ai/anythingmcp.git
cd anythingmcp && ./setup.sh && docker compose up -d
```

Open `http://localhost:3000/connectors/store`, click **Sorare**, and fill in `SORARE_EMAIL` + `SORARE_PASSWORD`. There is no AUD field (it's hardcoded to `anythingmcp`).

Mint an MCP API key under **Profile → MCP API Keys → New Key**.

---

## Step 2 — Register the MCP server in OpenClaw

OpenClaw stores MCP servers under the `mcp.servers` key in its config. Add Sorare with the CLI:

```bash
openclaw mcp set sorare '{
  "url": "http://localhost:4000/mcp",
  "transport": "streamable-http",
  "connectionTimeoutMs": 10000,
  "headers": {
    "Authorization": "Bearer YOUR_MCP_API_KEY"
  }
}'
```

Verify the registration:

```bash
openclaw mcp list
```

OpenClaw auto-discovers the 18 Sorare tools and makes them available to its agent runtime immediately. No restart needed.

---

## The 18 tools you get

Same set as for Claude and ChatGPT. Quick groups:

- **Identity / wallet:** `sorare_current_user`, `sorare_wallet_balance`, `sorare_my_trophies_summary`, `sorare_user_by_slug`
- **Cards:** `sorare_list_my_cards`, `sorare_get_card_by_slug`, `sorare_list_player_cards`
- **Players:** `sorare_search_player`, `sorare_player_recent_scores`, `sorare_player_floor_price`
- **Market:** `sorare_live_sale_offers`, `sorare_token_prices`, `sorare_get_auction`, `sorare_get_lineup`
- **Generic GraphQL escape hatch:** `sorare_graphql_schema_url`, `sorare_graphql_schema`, `sorare_graphql_query`, `sorare_graphql_mutation`, `sorare_graphql_subscription`

Field reference and pricing-convention notes (eurCents-in-cents, sender vs receiver side, crypto-only listings): [`sorare-to-mcp.md`](./sorare-to-mcp.md).

---

## Token rotation

AnythingMCP encrypts the Sorare JWT in `connector_auth_cache` (AES-256-GCM), refreshes it 24 h before expiry, and re-logs in on any 401. The token lives ~30 days. No cron, no manual refresh.

---

## FAQ

**Does OpenClaw need to be on the same machine as AnythingMCP?**
No. `http://localhost:4000/mcp` is just the default. Any reachable URL works — TLS + Bearer auth strongly recommended for cross-host setups.

**Where is the MCP server config stored on disk?**
Under `mcp.servers` in OpenClaw's global config — managed via `openclaw mcp set / list / remove`. See [docs.openclaw.ai/cli/mcp.md](https://docs.openclaw.ai/cli/mcp.md).

**Can I run multiple AnythingMCP adapters behind one OpenClaw entry?**
Yes. Every adapter you install in AnythingMCP becomes a tool on the same `/mcp` endpoint. One OpenClaw `mcp.servers.sorare` entry exposes all 18 Sorare tools at once.

**Can I keep my Sorare password off disk entirely?**
Set `SORARE_PASSWORD` via environment variable at install time and choose "do not persist credentials" if your AnythingMCP build supports it. Otherwise the password is encrypted at rest with AES-256-GCM in the `authConfig` blob (never written in plaintext anywhere).

---

## Links

- [Sorare to MCP — main hub](./sorare-to-mcp.md)
- [AnythingMCP repo](https://github.com/HelpCode-ai/anythingmcp)
- [OpenClaw docs](https://docs.openclaw.ai)
- [OpenClaw MCP CLI reference](https://docs.openclaw.ai/cli/mcp.md)
- [Sorare API official repo](https://github.com/sorare/api)
- [LOGIN_TOKEN auth reference](../connectors/login-token-auth.md)

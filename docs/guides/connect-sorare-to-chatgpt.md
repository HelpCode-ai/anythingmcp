<p align="center">
  <img src="../assets/icons/sorare.svg" alt="Sorare" width="220" />
</p>

> 💡 **No install? Use [cloud.anythingmcp.com](https://cloud.anythingmcp.com) directly.** Sign in, click **Connectors → Sorare**, paste your Sorare email + password, mint an MCP API key — done. No Docker, no `git clone`, no local server to run. You can skip the local-install steps below and jump straight to the client-wiring section.

# Connect Sorare to ChatGPT — fantasy football tools inside GPT

**Keywords:** connect sorare to chatgpt · sorare chatgpt · sorare gpt · sorare openai · sorare chatgpt connector · sorare chatgpt mcp · fantasy football chatgpt · sorare ai chatgpt

> Add the [Sorare GraphQL API](https://github.com/sorare/api) to **ChatGPT** as a custom MCP (Model Context Protocol) connector using [AnythingMCP](https://github.com/HelpCode-ai/anythingmcp). bcrypt login, 30-day JWT caching and 18 dedicated tools are handled for you.

Other guides in this directory:

- [Sorare to MCP — main hub](./sorare-to-mcp.md)
- [Connect Sorare to Claude](./connect-sorare-to-claude.md)
- [Connect Sorare to GitHub Copilot](./connect-sorare-to-copilot.md)
- [Connect Sorare to OpenClaw](./connect-sorare-to-openclaw.md)
- [Connect Sorare to AnythingMCP Cloud](./connect-sorare-to-cloud.md)

---

## What you can ask ChatGPT after this is wired up

- "Pull my current Sorare lineup and tell me where I'm weakest this game week."
- "List every Rare Vinícius Júnior card minted in season 2024."
- "What is the floor price for Limited Bukayo Saka right now? Is that a good buy?"
- "Find auctions for Liverpool players ending in the next 90 minutes."
- "How am I doing in So5 this season — show podium finishes and total monetary rewards."

ChatGPT picks the right Sorare MCP tool for each prompt — `sorare_get_lineup`, `sorare_token_prices`, `sorare_player_floor_price`, `sorare_live_sale_offers`, `sorare_my_trophies_summary`.

---

## Prerequisites

- ChatGPT **Plus**, **Team**, or **Enterprise** (custom connectors are gated to paid tiers).
- A Sorare account (https://sorare.com). **2FA off** for headless use — recommended to create a dedicated read-only Sorare account for this purpose.
- AnythingMCP either local (`./setup.sh && docker compose up -d`) or on [`cloud.anythingmcp.com`](https://cloud.anythingmcp.com).
- **Important:** ChatGPT can only reach **public HTTPS** URLs. If you run AnythingMCP locally, you need to expose it through Cloudflare Tunnel, ngrok or a reverse proxy. The simpler path is to use `cloud.anythingmcp.com`.

---

## Step 1 — Install the Sorare adapter

Same flow as any other client: open `https://cloud.anythingmcp.com/connectors` (or `http://localhost:3000/connectors/store` locally), pick **Sorare**, paste:

| Field | Value |
|---|---|
| `SORARE_EMAIL` | Sorare account email |
| `SORARE_PASSWORD` | Plain password (hashed locally with bcrypt before login) |

There is no AUD field to fill — the adapter hardcodes the JWT audience to `anythingmcp`.

Mint an MCP API key under **Profile → MCP API Keys → New Key**.

---

## Step 2 — Add the connector inside ChatGPT

1. In ChatGPT, open **Settings → Connectors → Add custom connector**.
2. Fill in:
   - **Name:** `Sorare`
   - **URL:** `https://cloud.anythingmcp.com/mcp` (or your tunneled host if you self-host).
   - **Authentication:** Bearer token → paste the MCP API key.
3. Save. ChatGPT auto-discovers the 18 Sorare tools.

---

## The 18 tools you get

Same set as for Claude. Quick groups:

- **Identity / wallet:** `sorare_current_user`, `sorare_wallet_balance`, `sorare_my_trophies_summary`, `sorare_user_by_slug`
- **Cards:** `sorare_list_my_cards`, `sorare_get_card_by_slug`, `sorare_list_player_cards`
- **Players:** `sorare_search_player`, `sorare_player_recent_scores`, `sorare_player_floor_price`
- **Market:** `sorare_live_sale_offers`, `sorare_token_prices`, `sorare_get_auction`, `sorare_get_lineup`
- **Generic GraphQL escape hatch:** `sorare_graphql_schema_url`, `sorare_graphql_schema`, `sorare_graphql_query`, `sorare_graphql_mutation`, `sorare_graphql_subscription`

Full reference and field-path notes: [`sorare-to-mcp.md`](./sorare-to-mcp.md).

---

## Token rotation

JWTs live ~30 days. AnythingMCP refreshes 24 h before expiry and re-logs in on any 401. ChatGPT calls never see a stale-token error.

---

## FAQ

**ChatGPT says "connector unreachable" or the connector silently has no tools.**
ChatGPT can't see `localhost` or private IPs. Either deploy to `cloud.anythingmcp.com` or expose your local instance with Cloudflare Tunnel / ngrok.

**Do I need ChatGPT Enterprise?**
No — custom connectors are available on Plus, Team and Enterprise.

**Can I make the connector read-only?**
Yes. Either drop `sorare_graphql_mutation` from the tool set in your MCP server config, or — for finer control — assign the connector a Role in AnythingMCP that whitelists only `sorare_get_*` / `sorare_list_*` / `sorare_current_user` / `sorare_wallet_balance` / `sorare_token_prices` etc.

**Why does the adapter ask for my Sorare password instead of an API token?**
Sorare doesn't issue API tokens. The only auth is the bcrypt + `signIn` flow described in the [Sorare API repo](https://github.com/sorare/api). AnythingMCP encrypts the password at rest (AES-256-GCM) and only the bcrypt hash crosses the wire on first sign-in.

---

## Links

- [Sorare to MCP — main hub](./sorare-to-mcp.md)
- [AnythingMCP repo](https://github.com/HelpCode-ai/anythingmcp)
- [AnythingMCP cloud](https://cloud.anythingmcp.com)
- [Sorare API official repo](https://github.com/sorare/api)
- [LOGIN_TOKEN auth reference](../connectors/login-token-auth.md)

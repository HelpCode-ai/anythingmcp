<p align="center">
  <img src="../assets/icons/sorare.svg" alt="Sorare" width="220" />
</p>

> 💡 **No install? Use [cloud.anythingmcp.com](https://cloud.anythingmcp.com) directly.** Sign in, click **Connectors → Sorare**, paste your Sorare email + password, mint an MCP API key — done. No Docker, no `git clone`, no local server to run. You can skip the local-install steps below and jump straight to the client-wiring section.

# Connect Sorare to GitHub Copilot — NFT fantasy football inside Copilot Chat

**Keywords:** connect sorare to copilot · sorare github copilot · sorare copilot mcp · sorare copilot chat · sorare vs code · sorare jetbrains · fantasy football copilot · NFT fantasy copilot

> Add the [Sorare GraphQL API](https://github.com/sorare/api) to **GitHub Copilot Chat** as an MCP (Model Context Protocol) server using [AnythingMCP](https://github.com/HelpCode-ai/anythingmcp). Bcrypt-salted login and 30-day JWT caching are handled for you.

Other guides in this directory:

- [Sorare to MCP — main hub](./sorare-to-mcp.md)
- [Connect Sorare to Claude](./connect-sorare-to-claude.md)
- [Connect Sorare to ChatGPT](./connect-sorare-to-chatgpt.md)
- [Connect Sorare to OpenClaw](./connect-sorare-to-openclaw.md)
- [Connect Sorare to AnythingMCP Cloud](./connect-sorare-to-cloud.md)

---

## What you can ask Copilot Chat after this is wired up

- "Sorare: what's my current wallet balance and how am I doing in So5 this season?"
- "Sorare: find the cheapest Limited card for Bukayo Saka right now."
- "Sorare: list my Rare cards by player, sorted by recent So5 score."
- "Sorare: show recent sale prices for Vinícius Júnior Rare cards over the last 30 days."

Each maps to one or two MCP tool calls against the Sorare adapter — Copilot picks the right tool from the 18 the adapter exposes.

---

## Prerequisites

- A Sorare account (https://sorare.com). For headless / agent use we recommend a **dedicated read-only account with 2FA disabled**.
- AnythingMCP either local (`./setup.sh && docker compose up -d`) or on [`cloud.anythingmcp.com`](https://cloud.anythingmcp.com).
- GitHub Copilot Chat with MCP support (VS Code Insiders ≥ 1.95 or JetBrains plugin with MCP).

---

## Step 1 — Install the Sorare adapter

```bash
git clone https://github.com/HelpCode-ai/anythingmcp.git
cd anythingmcp && ./setup.sh && docker compose up -d
```

Open `http://localhost:3000/connectors/store`, click **Sorare**, fill in:

| Field | Value |
|---|---|
| `SORARE_EMAIL` | your Sorare account email |
| `SORARE_PASSWORD` | your plain password |

Note: there is **no AUD field** — the adapter hardcodes the JWT audience to `anythingmcp`.

Mint an MCP API key under **Profile → MCP API Keys → New Key**.

---

## Step 2 — Add Sorare to Copilot's MCP servers

### VS Code

Open settings → search **Copilot: MCP servers** → add the following block (or edit `~/.config/Code - Insiders/User/settings.json` directly):

```json
{
  "mcp.servers": {
    "sorare": {
      "url": "http://localhost:4000/mcp",
      "transport": "http",
      "headers": {
        "Authorization": "Bearer YOUR_MCP_API_KEY"
      }
    }
  }
}
```

### JetBrains

Same JSON shape under **Settings → GitHub Copilot → MCP servers**.

For cloud, swap the URL for `https://cloud.anythingmcp.com/mcp`.

Restart Copilot Chat. The 18 Sorare tools appear automatically.

---

## The 18 tools, grouped

- **Identity / wallet:** `sorare_current_user`, `sorare_wallet_balance`, `sorare_my_trophies_summary`, `sorare_user_by_slug`
- **Cards / inventory:** `sorare_list_my_cards`, `sorare_get_card_by_slug`, `sorare_list_player_cards`
- **Players / form:** `sorare_search_player`, `sorare_player_recent_scores`, `sorare_player_floor_price`
- **Market:** `sorare_live_sale_offers`, `sorare_token_prices`, `sorare_get_auction`, `sorare_get_lineup`
- **Generic GraphQL escape hatch:** `sorare_graphql_schema_url`, `sorare_graphql_schema`, `sorare_graphql_query`, `sorare_graphql_mutation`, `sorare_graphql_subscription`

Full reference: [`sorare-to-mcp.md`](./sorare-to-mcp.md).

---

## Token rotation, explained for Copilot users

Sorare JWTs last ~30 days. AnythingMCP encrypts yours at rest (AES-256-GCM), re-issues 24 h before expiry, and re-logs in on any 401. Copilot never sees an expired-token error.

---

## FAQ

**Does Copilot need to be on the same machine as AnythingMCP?**
No. Any reachable URL works — TLS + Bearer auth strongly recommended for cross-host setups. `cloud.anythingmcp.com` works from any device.

**Can I scope Copilot to read-only Sorare tools?**
Yes. Create a Role in AnythingMCP that whitelists only `sorare_get_*`, `sorare_list_*`, `sorare_current_user`, `sorare_wallet_balance`, `sorare_token_prices` and `sorare_player_*`, then bind your MCP API key to that Role.

**Does this work in JetBrains too?**
Yes — same JSON shape under the JetBrains Copilot settings panel.

**Why does the adapter ask for my Sorare password instead of an API token?**
Sorare doesn't issue API tokens. The only auth is the bcrypt + `signIn` flow described in the [Sorare API repo](https://github.com/sorare/api). AnythingMCP encrypts the password at rest (AES-256-GCM) and only the bcrypt hash crosses the wire on first sign-in.

---

## Links

- [Sorare to MCP — main hub](./sorare-to-mcp.md)
- [AnythingMCP repo](https://github.com/HelpCode-ai/anythingmcp)
- [AnythingMCP cloud](https://cloud.anythingmcp.com)
- [Sorare API official repo](https://github.com/sorare/api)
- [LOGIN_TOKEN auth reference](../connectors/login-token-auth.md)

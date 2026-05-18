<p align="center">
  <img src="../assets/icons/sorare.svg" alt="Sorare" width="220" />
</p>

> 💡 **No install? Use [cloud.anythingmcp.com](https://cloud.anythingmcp.com) directly.** Sign in, click **Connectors → Sorare**, paste your Sorare email + password, mint an MCP API key — done. No Docker, no `git clone`, no local server to run. You can skip the local-install steps below and jump straight to the client-wiring section.

# Connect Sorare to Claude — NFT fantasy football inside Claude Desktop & Claude Code

**Keywords:** connect sorare to claude · sorare claude desktop · sorare claude code · sorare claude mcp · sorare ai claude · sorare anthropic · fantasy football claude · sorare claude integration

> Step-by-step guide to add the [Sorare GraphQL API](https://github.com/sorare/api) to **Claude Desktop** or **Claude Code** as an MCP (Model Context Protocol) server. Uses [AnythingMCP](https://github.com/HelpCode-ai/anythingmcp), which handles Sorare's bcrypt-salted login and 30-day JWT caching for you.

Other guides in this directory:

- [Sorare to MCP — the main hub](./sorare-to-mcp.md)
- [Connect Sorare to ChatGPT](./connect-sorare-to-chatgpt.md)
- [Connect Sorare to GitHub Copilot](./connect-sorare-to-copilot.md)
- [Connect Sorare to OpenClaw](./connect-sorare-to-openclaw.md)
- [Connect Sorare to AnythingMCP Cloud](./connect-sorare-to-cloud.md)

---

## What you can ask Claude after this is wired up

- "What's my Sorare wallet balance and how many Limited cards do I own?"
- "What did Limited Calafiori cards sell for in the last 30 days?"
- "Find me cheap Rare midfielders in the top 5 European leagues."
- "How am I doing in So5 this season?"
- "Show me my last So5 lineup."

Each of these maps to one or two MCP tool calls against the Sorare adapter — no manual GraphQL composition required.

---

## Prerequisites

- A Sorare account (https://sorare.com). For headless use we strongly recommend a **dedicated read-only account with 2FA disabled** — the `signIn` mutation refuses requests without a fresh OTP and there's no clean way to rotate OTPs from a server.
- Claude Desktop **or** Claude Code installed.
- Either:
  - AnythingMCP running locally (`git clone … && ./setup.sh && docker compose up -d`), **or**
  - An account on [`cloud.anythingmcp.com`](https://cloud.anythingmcp.com) — Sorare is in the catalog.

---

## Step 1 — Install the Sorare adapter

### Local

```bash
git clone https://github.com/HelpCode-ai/anythingmcp.git
cd anythingmcp && ./setup.sh && docker compose up -d
```

Open `http://localhost:3000/connectors/store`, click **Sorare**, fill in:

| Field | Value |
|---|---|
| `SORARE_EMAIL` | your Sorare account email |
| `SORARE_PASSWORD` | your plain password (never stored unencrypted; only the bcrypt hash leaves your server) |

Note: there is **no AUD field** — the adapter hardcodes the JWT audience to `anythingmcp`.

### Cloud

Sign in at `https://cloud.anythingmcp.com/connectors`, click **Sorare**, same two fields.

In both cases, mint an MCP API key under **Profile → MCP API Keys → New Key**.

---

## Step 2 — Wire it into Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%AppData%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "sorare": {
      "url": "http://localhost:4000/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_MCP_API_KEY"
      }
    }
  }
}
```

For cloud, swap the URL for `https://cloud.anythingmcp.com/mcp`.

Restart Claude Desktop. The Sorare tools appear in the 🔧 menu — 18 of them in this release.

---

## Step 3 — Wire it into Claude Code

In Claude Code, add the MCP server via the CLI or `~/.config/claude-code/mcp.json`:

```bash
claude mcp add sorare \
  --transport http \
  --url http://localhost:4000/mcp \
  --header "Authorization: Bearer YOUR_MCP_API_KEY"
```

Verify with `claude mcp list`. Sorare tools become available in any Claude Code session.

---

## The 18 tools, grouped

- **Identity / wallet:** `sorare_current_user`, `sorare_wallet_balance`, `sorare_my_trophies_summary`, `sorare_user_by_slug`
- **Cards / inventory:** `sorare_list_my_cards`, `sorare_get_card_by_slug`, `sorare_list_player_cards`
- **Players / form:** `sorare_search_player`, `sorare_player_recent_scores`, `sorare_player_floor_price`
- **Market:** `sorare_live_sale_offers`, `sorare_token_prices`, `sorare_get_auction`, `sorare_get_lineup`
- **Generic GraphQL escape hatch:** `sorare_graphql_schema_url`, `sorare_graphql_schema`, `sorare_graphql_query`, `sorare_graphql_mutation`, `sorare_graphql_subscription`

Full reference: [`sorare-to-mcp.md`](./sorare-to-mcp.md).

---

## Token rotation, explained for Claude users

Sorare JWTs last ~30 days. AnythingMCP encrypts yours at rest (AES-256-GCM), **re-issues it 24 h before expiry**, and re-logs in on any 401 — without your password ever being re-read from disk (the bcrypt hash is recomputed from the freshly fetched salt). Claude never sees an expired-token error.

---

## FAQ

**Does AnythingMCP store my Sorare password in plain text?**
No. The password is encrypted in `authConfig` with AES-256-GCM. The bcrypt hash is what crosses the wire — only on `signIn`, only on first use or after the cached JWT expires.

**Can I use a Sorare account with 2FA?**
The `signIn` mutation requires a fresh `otpAttempt` when 2FA is on, and there's no clean way to automate it. Use a dedicated read-only account without 2FA.

**Does this work for Claude Code too?**
Yes — same MCP endpoint and Bearer header. See Step 3.

**Why does the wallet show prices in `eurCents`?**
Sorare expresses fiat amounts as integer cents. Divide by 100 for the currency unit (`354` → €3.54). This is documented in the adapter `instructions` block so Claude reads it automatically before composing prompts.

---

## Links

- [Sorare to MCP — main hub](./sorare-to-mcp.md)
- [AnythingMCP repo](https://github.com/HelpCode-ai/anythingmcp)
- [AnythingMCP cloud](https://cloud.anythingmcp.com)
- [Sorare API official repo](https://github.com/sorare/api)
- [LOGIN_TOKEN auth reference](../connectors/login-token-auth.md)

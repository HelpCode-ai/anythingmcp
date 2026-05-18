<p align="center">
  <img src="../assets/icons/sorare.svg" alt="Sorare" width="220" />
</p>

> 💡 **No install? Use [cloud.anythingmcp.com](https://cloud.anythingmcp.com) directly.** Sign in, click **Connectors → Sorare**, paste your Sorare email + password, mint an MCP API key — done. No Docker, no `git clone`, no local server to run. You can skip the local-install steps below and jump straight to the client-wiring section.

# Sorare to MCP — Connect Sorare GraphQL API to any AI agent

**Keywords:** sorare mcp · sorare to mcp · sorare graphql mcp · sorare api mcp · sorare model context protocol · sorare ai · sorare ai agent · connect sorare api · sorare bcrypt auth · sorare jwt 30 days · fantasy football mcp · nft fantasy mcp

> The official [Sorare GraphQL API](https://github.com/sorare/api) wrapped as an **MCP (Model Context Protocol) server** by [AnythingMCP](https://github.com/HelpCode-ai/anythingmcp). Bcrypt-salted login, 30-day JWT caching, and **18 ready-to-use tools** for cards, players, lineups, auctions, wallet, scoring history and the transfer market. Drop-in for Claude, ChatGPT, OpenClaw, Cursor, Codex and any other MCP-aware client.

Other companion guides in this directory:

- [Connect Sorare to Claude](./connect-sorare-to-claude.md)
- [Connect Sorare to ChatGPT](./connect-sorare-to-chatgpt.md)
- [Connect Sorare to GitHub Copilot](./connect-sorare-to-copilot.md)
- [Connect Sorare to OpenClaw](./connect-sorare-to-openclaw.md)
- [Connect Sorare to AnythingMCP Cloud](./connect-sorare-to-cloud.md)

---

## What "Sorare to MCP" means

[Sorare](https://sorare.com/) is the largest licensed NFT fantasy football, baseball and basketball game. Its [GraphQL API](https://api.sorare.com/graphql) covers everything you can see in the web app — cards, players, the secondary-market transfer offers, So5 lineups, score history, your wallet — but it has two quirks that make it hard to drive from a generic GraphQL client:

1. **Custom auth.** Sorare doesn't issue plain API keys or OAuth2. Sign-in is a bcrypt handshake: fetch a per-account salt from `GET /api/v1/users/{email}`, hash your password locally with `bcrypt.hashSync(password, salt)`, then POST the hash through a `signIn` GraphQL mutation. You get back a JWT good for ~30 days plus an `aud` claim you have to echo on every call as the `JWT-AUD` header.
2. **Introspection is disabled on production.** You can't query `__schema` or `__type`; the only way to discover types is to fetch the SDL at `https://api.sorare.com/graphql/schema` (816 KB).

The Sorare MCP adapter handles both transparently:

- The new `LOGIN_TOKEN` AuthType in AnythingMCP runs salt-fetch → bcrypt → `signIn` for you, caches the JWT in-memory + in an AES-256-GCM-encrypted DB row, refreshes it 24 h before expiry, and re-issues it transparently on any 401.
- The auto-injected `sorare_graphql_schema` tool **proxies the SDL through the MCP server** and returns task-sized slices — no allowlist concerns, no 200 K-token blow-up. Pass `type: "CurrentUser"` to retrieve one type, `search: "auction"` to find every type whose name or fields contain the term, or `full: true` for the entire SDL.

The whole flow is one MCP tool call from the agent's point of view — `sorare_current_user` or `sorare_wallet_balance` just works, no auth ceremony.

---

## Quick start (60 seconds)

```bash
git clone https://github.com/HelpCode-ai/anythingmcp.git
cd anythingmcp && ./setup.sh
docker compose up -d
```

Open `http://localhost:3000/connectors/store`, click **Sorare**, paste your `SORARE_EMAIL` and `SORARE_PASSWORD` (no AUD field — it's hardcoded to `anythingmcp`). Mint an MCP API key from **Profile → MCP API Keys**. Point any MCP client at `http://localhost:4000/mcp` with `Authorization: Bearer <your-key>`.

If you prefer SaaS, sign up on `https://cloud.anythingmcp.com` — Sorare is in the catalog there too, with no install step on your side.

---

## The 18 tools the adapter exposes

### Identity & wallet

| Tool | What it returns |
|---|---|
| `sorare_current_user` | Authenticated profile (slug, email, nickname) |
| `sorare_wallet_balance` | Available balances in wei + EUR + USD + GBP — read **cents, divide by 100** |
| `sorare_my_trophies_summary` | finalRankings, podiumRankings, cardRewards, lifetime monetary reward |
| `sorare_user_by_slug` | Any other user's public profile + verified badge |

### Cards & inventory

| Tool | What it returns |
|---|---|
| `sorare_list_my_cards` | Your owned cards filterable by rarity (default 20) |
| `sorare_get_card_by_slug` | One card with player, season, owner, live sale offer **and the price the buyer pays** |
| `sorare_list_player_cards` | Recent cards minted for a given player slug |

### Players & form

| Tool | What it returns |
|---|---|
| `sorare_search_player` | Full-text player search → slug, name, club, country (use slugs in other tools) |
| `sorare_player_recent_scores` | Last N So5 scores for form/in-form analysis |
| `sorare_player_floor_price` | The cheapest card listed for a player at a chosen rarity — single round-trip |

### Market & auctions

| Tool | What it returns |
|---|---|
| `sorare_live_sale_offers` | Live secondary-market offers — fixed in this release to read `receiverSide.amounts` so prices are real, not zero |
| `sorare_token_prices` | Historical sale prices for a player + rarity over a window |
| `sorare_get_auction` | One specific auction by id |
| `sorare_get_lineup` | One So5 lineup by id |

### Generic GraphQL helpers (auto-injected on every GraphQL adapter)

| Tool | What it returns |
|---|---|
| `sorare_graphql_schema_url` | The literal URL of the SDL — `https://api.sorare.com/graphql/schema` |
| `sorare_graphql_schema` | Proxied + filtered SDL: default summary, `type:` slice, `search:` slice, or `full:true` |
| `sorare_graphql_query` | Execute an arbitrary GraphQL query |
| `sorare_graphql_mutation` | Execute an arbitrary GraphQL mutation |
| `sorare_graphql_subscription` | Execute an arbitrary GraphQL subscription (transport-dependent) |

---

## Sorare pricing & API gotchas (so your agent gets it right the first time)

These are baked into the adapter's `instructions` block so the model sees them automatically, but worth surfacing here for humans skimming the repo:

- `eurCents` / `usdCents` / `gbpCents` are **integers in cents**. `354` means **€3.54**, not €354.
- On a **single-sale offer**, `senderSide` = the seller (sending the card) and `receiverSide` = the buyer (paying the price). Reading `senderSide.amounts` gives **zero** because the seller isn't sending money. Always read prices from `receiverSide.amounts`.
- Cards listed only in crypto have `eurCents: null`. Fall back to `wei` (1 ETH = 10¹⁸ wei).
- **Sport** enum is upper-snake (`FOOTBALL`, `BASEBALL`, `NBA`). **Rarity** enum is lowercase (`common`, `limited`, `rare`, `super_rare`, `unique`, `custom_series`). **Season** is the start year (`2024` = the 2024-25 season).
- Older vintage cards still score normally in So5 Classic; vintage mainly affects the Captain Bonus and season-eligibility tournaments.

---

## Example workflows

**"What's my Sorare wallet worth?"**
→ `sorare_wallet_balance` → divide `eurCents` by 100.

**"What does a Limited Calafiori card cost right now?"**
→ `sorare_player_floor_price(playerSlug: "riccardo-calafiori", rarity: "limited")`.

**"Should I buy this card at €X?"**
→ `sorare_token_prices(playerSlug, rarity: "limited", first: 30)` for recent sale history + `sorare_player_recent_scores(playerSlug, last: 10)` for form.

**"Find me cheap rare Premier League midfielders."**
→ `sorare_graphql_query` with `football.allCards(rarities: [rare], inActiveCompetitions: ["premier-league"], first: 20)` plus the schema slice from `sorare_graphql_schema(type: "FootballRoot")` to compose the right arguments.

---

## How it compares to writing your own Sorare client

| | Hand-rolled | AnythingMCP Sorare adapter |
|---|---|---|
| Login + bcrypt + salt fetch | ~80 LOC + tests | 0 (declarative `LOGIN_TOKEN` auth) |
| Token storage + 30-day refresh | DB + cron | 0 (built in) |
| Schema discovery (introspection blocked) | Manual SDL parsing | `sorare_graphql_schema(type:…)` |
| Per-call header injection (`JWT-AUD`) | Custom interceptor | 0 (auto) |
| Multi-client (Claude + ChatGPT + …) | Re-implement per client | One MCP endpoint, every client uses it |

---

## Links

- AnythingMCP repo: https://github.com/HelpCode-ai/anythingmcp
- AnythingMCP cloud: https://cloud.anythingmcp.com
- Sorare API docs (official): https://github.com/sorare/api
- Sorare SDL (raw): https://api.sorare.com/graphql/schema
- LOGIN_TOKEN auth reference: [../connectors/login-token-auth.md](../connectors/login-token-auth.md)
- Tool definition format: [../tool-definition.md](../tool-definition.md)

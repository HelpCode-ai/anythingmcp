### Is there an Etsy MCP server?
Yes, this one. It connects the Etsy Open API v3 to Claude, ChatGPT and Copilot through AnythingMCP: 24 tools for your shop, listings, orders (receipts), sold items, reviews, shipping and return policies, and creating and editing listings.

### How do I connect my shop?
Etsy only lets other tools reach a shop through an app you register yourself. Create one at `etsy.com/developers/register`, then add the callback URL `<your AnythingMCP URL>/api/mcp-oauth/callback` to the app (on AnythingMCP Cloud: `https://cloud.anythingmcp.com/api/mcp-oauth/callback`), exactly as written. Enter the app's Keystring and Shared secret, click **Authorize with Provider** and approve access on Etsy. A new app can stay Pending until Etsy activates it, and sign-in only works after that.

### What access does it ask for?
The scopes `email_r shops_r listings_r listings_w transactions_r transactions_w`: read your account, shop, listings and orders, edit listings, and add tracking to orders. If you installed the connector before October 2026 it only asked for read scopes; set the scopes above in the connector's OAuth settings and authorize again, or Etsy answers "Access token lacks scope" on writes.

### Can the AI change my shop?
Yes, five tools write: create a draft listing, edit a listing (including publishing it), set a listing's inventory, add a photo and add order tracking. Adding tracking marks the order shipped and Etsy emails the buyer at once. There is no tool to delete a listing. Setting inventory replaces the whole inventory of the listing, so the AI should read it first. For a read-only setup, leave the write tools off the MCP server's role.

### Are there rate limits?
Etsy allows 10,000 requests per 24 hours per app and answers 429 beyond that. Tokens renew automatically; if one cannot be renewed (an Etsy refresh token expires after 90 days unused), click **Authorize with Provider** again.

### Does it work with ChatGPT and Copilot?
Yes. The same MCP server works in ChatGPT (with a public HTTPS URL such as AnythingMCP Cloud), GitHub Copilot in VS Code, Cursor and Claude Code. The adapter has not been run against a live Etsy shop yet; if you try it, please report what works.

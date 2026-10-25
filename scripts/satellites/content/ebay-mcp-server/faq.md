### Is there an eBay MCP server?
Yes, this one. It connects the eBay Sell APIs to Claude, ChatGPT and Copilot through AnythingMCP: 10 tools for orders, inventory items, offers, payment disputes, shipping and return policies, selling privileges and offer price updates. It talks to the production marketplace.

### How do I connect my seller account?
Register at `developer.ebay.com` and create a production keyset (App ID, Cert ID and an RuName). The Sell APIs need a user token, so run eBay's authorization once for the seller account, with the scopes `sell.inventory`, `sell.fulfillment`, `sell.account` and, for disputes, `sell.payment.dispute`. Paste the refresh token it returns (about 18 months) into the connector, with the App ID, Cert ID and your marketplace (such as `EBAY_DE`). AnythingMCP does not run the sign-in itself, so there is no AnythingMCP callback URL to register: eBay uses the RuName as the redirect.

### Does it work in the eBay sandbox?
Not as shipped. The adapter points at the production host `api.ebay.com`. The sandbox is a separate host with its own keyset and tokens, and a production token fails there with a 401.

### Can the AI change my listings?
One tool writes: `ebay_sell_update_offer_price`. It changes the price of a published offer and buyers see it immediately; eBay allows 250 revisions per listing per day. Everything else only reads. To keep the AI read-only, leave that tool off the MCP server's role.

### Why is my inventory almost empty?
The Sell Inventory API only sees listings created through it or migrated into it. If your listings were created with eBay's older Trading API, the inventory and offers tools return little while your shop is full; orders, disputes and policies are not affected. Returns are not a tool here, only your return policies.

### Does it work with ChatGPT and Copilot?
Yes. The same MCP server works in ChatGPT (with a public HTTPS URL such as AnythingMCP Cloud), GitHub Copilot in VS Code, Cursor and Claude Code. The adapter has not been run against a live eBay seller account yet; if you try it, please report what works.

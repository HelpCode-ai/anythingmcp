### Is there a Mercado Libre MCP server?
Yes, this one. It connects the Mercado Libre API to Claude, ChatGPT and Copilot through AnythingMCP: 17 tools to read your orders, listings and seller profile, look up categories, and create, validate, change, pause and close listings. It covers Brasil, Argentina, Mexico, Chile, Colombia, Peru and Uruguay.

### How do I connect my seller account?
Create an application in the Mercado Libre developer center of your country (`developers.mercadolibre.com/devcenter`) and register the redirect URI `<your AnythingMCP URL>/api/mcp-oauth/callback` (on AnythingMCP Cloud: `https://cloud.anythingmcp.com/api/mcp-oauth/callback`), exactly as written. Leave the application's notifications callback URL empty. Enter the App ID, the Secret Key and your country site (such as `mercadolivre.com.br`), then authorize with your seller account, keeping the scopes `offline_access read write`.

### Can the AI change my listings?
Yes. Six tools change your account: create a listing, update it (price, stock, pictures, attributes), pause or reactivate it, close it, and add or replace its description. A seventh, validate, only checks a new listing. Mercado Libre has no sandbox, so a created or changed listing is live at once. Closing a listing is permanent and that tool is installed switched off. Run validate before creating: it checks without publishing. For a read-only setup, leave the write tools off the MCP server's role.

### Can it search all of Mercado Libre?
No. Mercado Libre refuses its public marketplace search to third-party applications, so the connector has no such tool. It lists your own listings (by status or SKU) and reads any listing by its id. Seller tools only answer for the account you signed in with.

### Does it see returns or claims?
No. The tools cover orders, listings, categories and the seller profile, not returns or claims.

### Does it work with ChatGPT and Copilot?
Yes. The same MCP server works in ChatGPT (with a public HTTPS URL such as AnythingMCP Cloud), GitHub Copilot in VS Code, Cursor and Claude Code. The adapter has not been run against a live Mercado Libre account yet; if you try it, please report what works.

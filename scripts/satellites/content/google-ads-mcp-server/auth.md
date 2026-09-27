The connector signs in with OAuth 2.0 as a Google user. You need an OAuth client from a Google Cloud project that has Google Ads API access:

| Variable | Where to find it |
|---|---|
| `GOOGLE_CLIENT_ID` | Google Cloud console → **APIs & Services → Credentials** → OAuth client ID (type **Web application**) |
| `GOOGLE_CLIENT_SECRET` | the same OAuth client |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` (optional) | the 10-digit id of the manager (MCC) account, only when you reach client accounts through a manager |

1. Enable **Google Ads API** in the project and check its access level on the project's Google Ads API page. A new project starts at **Test** (test accounts only); request **Explorer** to read real accounts. Since 9 September 2026 no developer token is needed.
2. Add the redirect URI `<your AnythingMCP URL>/api/mcp-oauth/callback` to the OAuth client (on AnythingMCP Cloud: `https://cloud.anythingmcp.com/api/mcp-oauth/callback`), and set the OAuth consent screen to **In production** so the refresh token does not expire after 7 days.
3. Install the connector with the client ID and secret, then click **Authorize with Provider** on the connector page. The refresh token is stored encrypted and access tokens are renewed automatically.

Google Ads has a single OAuth scope (`adwords`) and it is not read-only. The connector exposes only read tools; authorizing a Google Ads user with the *Read only* role adds a second safeguard.

The connector needs two values:

| Variable | Where to find it |
|---|---|
| `WECLAPP_TENANT` | The subdomain of your weclapp URL: `yourcompany` in `yourcompany.weclapp.com` |
| `WECLAPP_API_TOKEN` | weclapp → **My Settings → API Tokens** → generate a token |

The token is sent as the `AuthenticationToken` header to `https://<tenant>.weclapp.com/webapp/api/v2`. It acts with the rights of the weclapp user who created it, so create it with a user that sees only the data the AI should see.

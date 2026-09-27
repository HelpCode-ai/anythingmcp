The connector needs one value:

| Variable | Where to find it |
|---|---|
| `TYPESAFE_API_KEY` | [console.typesafe.ai](https://console.typesafe.ai) → create an API key |

The key is sent as `Authorization: Bearer <key>` to `https://api.typesafe.ai`. At install, AnythingMCP checks it with a free `GET /v1/models` call and then stores it encrypted.

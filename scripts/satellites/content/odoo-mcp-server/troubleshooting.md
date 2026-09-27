| `404` on every call | The instance is Odoo 18 or older, which has no JSON-2 API (`/json/2`). Upgrade to 19+, or build a custom connector against `/jsonrpc`. |
| The AI finds no records you know exist | The API key's user lacks access rights or record rules hide the rows. Check which user created the key. |
| Answers are cut off or the model loses track | A `search_read` without `fields` returns every column. Ask for specific fields, or run `odoo_fields_get` first. |

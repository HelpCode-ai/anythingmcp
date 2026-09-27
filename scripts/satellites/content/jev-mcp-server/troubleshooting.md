| Symptom | Cause and fix |
|---|---|
| `401` on every call | The API key is wrong or was revoked. Create a new one at console.typesafe.ai and update `TYPESAFE_API_KEY` on the connector. |
| `400 Invalid request.` | A question has a type other than `noul`, `choice` or `score` (there is no `bool`), or the request carries a field Jev does not know. The tool result includes a hint that lists the valid shapes. |
| `422` naming `score.criteria` | Score levels must be an array, lowest first, not an object. |
| `400 Too many score levels` / `Too many choices` | A score takes at most 10 levels and a choice at most 255 options. |
| `429` or `529` | TypeSafe's rate limit or a temporary overload. The connector retries with backoff; spread large batches over time. |
| A yes/no answer near 0.5 | Jev is unsure, not saying "medium". Ask a narrower question about the specific evidence, or pass more context in `state`. |

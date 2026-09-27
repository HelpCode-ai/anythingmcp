| Symptom | Cause and fix |
|---|---|
| `CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION` | The Cloud project behind the OAuth client still has Test access. Request Explorer access on the project's Google Ads API page. |
| `USER_PERMISSION_DENIED` on a client account | You reach the account through a manager: set `GOOGLE_ADS_LOGIN_CUSTOMER_ID` to that manager's id, or authorize a user with direct access. |
| `401` or `invalid_grant` | The refresh token was revoked or expired (an OAuth consent screen in Testing expires it after 7 days). Set the consent screen to In production and click **Authorize with Provider** again. |
| `UNRECOGNIZED_FIELD` or `PROHIBITED_*` from `gads_run_gaql` | A field name is wrong or does not combine with the resource. Check it with `gads_query_field_catalog`. |
| `RESOURCE_EXHAUSTED` | The daily or per-minute quota of the Cloud project is used up. Wait, or request a higher access level. |
| Campaign rows with zero metrics | Paused or idle campaigns are returned too and sort last; they are not an error. |
| Amounts look a million times too large | Money fields are in micros of the account currency: divide by 1,000,000. |

# Sign-up attribution

Which channel brings AnythingMCP Cloud sign-ups, and which of them verify and pay. Cloud only: a self-hosted instance records nothing.

## How it is recorded

1. **anythingmcp.com** notes, per visitor, the first and the last *touch*: UTM tags, Google Ads' `gad_source` / `gad_campaignid`, `paid` (a gclid, gbraid or wbraid was on the URL), the referrer's host and the landing path. The click id itself travels only with `ad_consent: "granted"` (the visitor allowed marketing cookies). Kept in memory for the visit, and in localStorage for 30 days only once the visitor has allowed analytics in the cookie banner.
2. When the visitor clicks through to `cloud.anythingmcp.com`, the link gets `amcp_src=<base64url JSON first touch>` and, if different, `amcp_lt=<last touch>`.
3. **The cloud sign-up page** reads those, or, for a visitor who came straight to the cloud app, builds its own touch from its URL and the referrer's host (`captured_on: "cloud"`). For its own touch, a click id is kept only if the cloud's cookie banner has the *marketing* category accepted; if that banner says no, click ids handed over by the site are dropped too. It sends them with `POST /api/auth/register` as `attribution: { first_touch, last_touch }`.
4. **The backend** sanitizes them again and, for a **newly created account only**, writes a `signup_attributed` row to `product_events` (`user_id`, `organization_id` = the workspace created at sign-up). A click id (`gclid`, `gbraid`, `wbraid`: `[A-Za-z0-9_-]`, at most 150 characters) is stored only on a touch with `ad_consent: "granted"` and dropped otherwise. An address that already has an account records nothing, and the answer to the sign-up is the same either way.

## Purchases as Google Ads offline conversions

`GET /api/auth/attribution/click-ids` (signed in, cloud only; `{}` on self-hosted) returns the caller's own click id from their `signup_attributed` row, e.g. `{ "gclid": "…", "ad_consent": "granted", "captured_at": "…" }`: one id (last touch before first; gclid before gbraid before wbraid), and only if it was stored with consent. The cloud app appends it to its links to the pricing page (`?return_url=…&gclid=…`); the pricing page puts it into the Stripe checkout metadata and the site's Stripe webhook uploads the purchase to Google Ads.

Stored metadata (the channel is derived on the server, see `packages/backend/src/audit/signup-attribution.ts`):

```json
{
  "first_channel": "google_ads",
  "last_channel": "ai_assistant",
  "first_touch": {
    "utm_source": "google", "utm_medium": "cpc", "utm_campaign": "pmax-de",
    "gad_source": "1", "gad_campaignid": "22334455", "paid": true,
    "referrer_host": "google.com", "landing_path": "/de/guides/sap-business-one",
    "ts": "2026-09-24T08:30:00.000Z", "captured_on": "site", "channel": "google_ads"
  },
  "last_touch": {
    "utm_source": "chatgpt.com", "referrer_host": "chatgpt.com", "landing_path": "/login",
    "ts": "2026-09-24T09:30:00.000Z", "captured_on": "cloud", "channel": "ai_assistant"
  }
}
```

Channels: `google_ads`, `paid_other`, `ai_assistant`, `github`, `organic_google`, `organic_search`, `social`, `email`, `website` (came from anythingmcp.com but without its touch, e.g. scripts blocked), `referral`, `direct`.

## Reports

Run against the cloud database (see the droplet notes for access). Sign-ups before the feature shipped, and accounts created by invitation or SSO, have no `signup_attributed` row; the first query counts them as `unattributed`.

**Sign-ups, verified sign-ups and paying workspaces by channel, last 30 days:**

```sql
WITH signups AS (
  SELECT u.id AS user_id,
         u.email_verified,
         COALESCE(pe.metadata->>'first_channel', 'unattributed') AS first_channel,
         COALESCE(pe.metadata->>'last_channel',  'unattributed') AS last_channel
  FROM users u
  LEFT JOIN product_events pe
         ON pe.user_id = u.id AND pe.event = 'signup_attributed'
  WHERE u.created_at >= now() - interval '30 days'
),
paying AS (
  -- A member of any workspace with a paid plan. Status is not filtered, so a
  -- customer who paid and later cancelled still counts as a conversion.
  SELECT DISTINCT om.user_id
  FROM organization_members om
  JOIN licenses l ON l.organization_id = om.organization_id
  WHERE l.plan NOT IN ('trial', 'community')
)
SELECT s.first_channel,
       count(*)                                  AS signups,
       count(*) FILTER (WHERE s.email_verified)  AS verified,
       count(p.user_id)                          AS paying,
       round(100.0 * count(*) FILTER (WHERE s.email_verified) / count(*), 1) AS verified_pct
FROM signups s
LEFT JOIN paying p ON p.user_id = s.user_id
GROUP BY s.first_channel
ORDER BY signups DESC;
```

Swap `first_channel` for `last_channel` for last-touch attribution.

**Google Ads by campaign** (is Performance Max buying sign-ups that never verify?):

```sql
SELECT COALESCE(pe.metadata->'first_touch'->>'gad_campaignid',
                pe.metadata->'first_touch'->>'utm_campaign', '?') AS campaign,
       count(*)                                 AS signups,
       count(*) FILTER (WHERE u.email_verified) AS verified
FROM product_events pe
JOIN users u ON u.id = pe.user_id
WHERE pe.event = 'signup_attributed'
  AND pe.metadata->>'first_channel' = 'google_ads'
  AND pe.created_at >= now() - interval '30 days'
GROUP BY 1
ORDER BY signups DESC;
```

**Referrers behind a channel** (which AI assistant, which site):

```sql
SELECT pe.metadata->'first_touch'->>'referrer_host' AS referrer, count(*)
FROM product_events pe
WHERE pe.event = 'signup_attributed'
  AND pe.metadata->>'first_channel' IN ('ai_assistant', 'referral')
GROUP BY 1
ORDER BY 2 DESC;
```

## Verified sign-ups in Google Ads

The cloud frontend pushes `{ event: 'sign_up_verified', method: 'code' | 'link' }` to `window.dataLayer` once, when an email verification succeeds (the code on the sign-in page, or the link to `/verify-email`). It carries no email, name or id, and it only happens where GTM is loaded (`GTM_ID` set, i.e. AnythingMCP Cloud). In GTM, a *Custom Event* trigger on `sign_up_verified` drives the Google Ads conversion tag; that conversion, not the register-form submit, should be the primary one.

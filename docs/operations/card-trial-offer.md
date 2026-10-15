# Card-trial offer after the first success

AnythingMCP Cloud offers the card trial at the moment a workspace sees the product work: right after its first successful tool call. Cloud only (`DEPLOYMENT_MODE=cloud`); a self-hosted instance records and shows nothing.

## How it works

**Trigger.** When a tool call succeeds and is stored in `tool_invocations`, `FirstSuccessService` (`packages/backend/src/audit/first-success.service.ts`) checks the workspace once per process, in the background:

1. It stores the workspace's first success time in `org_settings` (`first_successful_call_at`), unless it is already there. The check stops at this indexed read for every later call, and after a restart.
2. If that first success is less than 24 hours old and the workspace is on the **no-card trial**, it marks the workspace eligible: `org_settings.card_trial_offer_eligible_at` plus one `card_trial_offer_eligible` product event (`metadata.connectorId`, `adapterSlug`, `toolName`). The settings row is created with `ON CONFLICT DO NOTHING`, so two processes never record it twice.

No-card trial means: a running `trial` licence, and no other licence in any state. Paying workspaces, card trials (a `starter`/`team` licence while Stripe says trialing), former customers and ended trials are not eligible, and keep the existing banners and licence wall. Workspaces that activated before this shipped get their first success stored, not the offer.

The licence site gives no card trial to an address that ever held a subscription (it charges today), so a workspace where the site says that of every active admin is not made eligible either (`CardTrialEligibilityService`, backed by `POST /api/license/subscription-history`). No answer counts as eligible; the in-app offer and `/start-trial` check again.

**In the app.** `GET /api/license/card-trial-offer` answers `{ offer: { connectorName, trialEndsAt } }` for an admin of an eligible workspace while a card trial can still start (48 hours of free trial left) and whose own address never had a subscription, and `{ offer: null }` for everyone else, members who are not admins included. While the card is on screen, the top trial banner keeps its countdown but drops its own "Add a payment method" link, so there is one call to action at a time. The dashboard, the connector list and the connect page (`/mcp-server/<id>`, which re-asks a few seconds after the live check sees the first request) show a dismissible card:

> **Your AI just ran its first My Shopify store action.**
> Keep it running: start your trial, and My Shopify store keeps working after your free trial ends on 18 October 2026.
> [Not now] [Start your trial]

The button opens `/start-trial?source=first_success_banner`. "Not now" hides the card for three days on every page (localStorage, per user). Events: `card_trial_offer_shown` (once a day per user and browser), `card_trial_offer_clicked`, `card_trial_offer_dismissed`, each with `metadata.via` = `dashboard`, `connectors` or `connect`.

**Email.** The hourly Cloud onboarding cron runs `CardTrialOfferService.runEmailPass` after its trial-lifecycle and win-back passes. One email per workspace, to its active, verified admins who did not unsubscribe and whose address never had a subscription (without an answer from the licence site the email waits for the next run), between 30 minutes and 48 hours after it became eligible (30 to 90 minutes in practice). It is checked again at send time and is not sent once the workspace started a card trial, pays, or its trial ended. It waits while another email went out in the last 12 hours: a trial-lifecycle or win-back email to the workspace (`org_settings.trial_email_*`), or an onboarding or activation nudge to one of its admins (`users.onboarding_last_reminder_at`, `users.activation_reminder_at`). `org_settings.card_trial_offer_email` settles it: the send time, or `skipped:<reason>` (`customer`, `trial_ended`, `no_trial`, `no_recipient`, `no_trial_recipient`). A failed send is retried by the next run inside the window. Sent emails record `card_trial_offer_emailed` (`metadata.kind` = `trial`, or `plan` when under 48 hours were left and the email linked to the plans instead). The email's button opens `/start-trial?source=first_success_email` (or `/settings/license?source=first_success_email`, which passes the source on to its card-trial button and its pricing link), so the email and the in-app card are counted apart. Emails sent before 16 October 2026 say `source=first_success`, which is still accepted.

The email talks about value only (the connection works, up to three things to ask next, taken from the connector's own tools, the trial's end date and a link back to the app), never about cards, charges or prices, and it carries the unsubscribe line. Nothing of the offer is ever part of an MCP tool response.

## Attribution to Stripe

Every Cloud checkout names where it started, and the licence site writes it to the Stripe Checkout Session and to the subscription as `metadata.checkout_source`. Card trials also get the same value as `metadata.trial_source` (the key the first version used; it is left off pay-now checkouts, where the name would be wrong).

**In-app checkouts** (`POST /api/license/checkout-link` → the site's `POST /api/stripe/checkout-intent`). The frontend sends `source`; the backend accepts only `CHECKOUT_SOURCES` (`packages/backend/src/license/license-checkout.ts`, mirrored in `packages/frontend/src/lib/checkout-source.ts`) and sends `app` when the page named none, so no intent goes without one. It also records `checkout_link_created` with `metadata.via` = the same value and `metadata.kind` = `trial` or `pay`.

| Source | Entry point |
|---|---|
| `first_success_banner` | the first-success card (dashboard, connectors, connect page) |
| `first_success_email` | the first-success email |
| `first_success` | the same offer before banner and email were told apart (old emails, open tabs) |
| `trial_banner` | the countdown banner's "Add a payment method" / "Choose a plan" |
| `license_page` | Settings → License |
| `trial_ended_wall` | the wall after the free trial ("Subscribe to …") |
| `post_approve` | "add a card now" on the page after approving an AI client |
| `signup_prompt` | the card-trial page shown once after sign-up |
| `trial_limit`, `starter_pack` | "add a card" next to the connector limit |
| `chat_setup` | the plan link the setup tools give the AI (`upgradeUrl`, `choosePlanUrl`) |
| `start_trial` | `/start-trial` opened without a known source |
| `app` | a checkout the page did not name |

**Pricing-page checkouts** (`anythingmcp.com/pricing` → `POST /api/stripe/checkout`). Links to the pricing page carry `?source=`: `app_pricing` (any app link, the default of `usePricingUrl`), `trial_banner`, `license_page`, `trial_ended_wall`, `first_success_email`, `chat_setup`, and from the Cloud's emails `email_trial_warn3`, `email_trial_warn1`, `email_trial_expired`, `email_winback`. The site keeps only the values in its `PRICING_CHECKOUT_SOURCES` and records everything else, a visitor who came on their own included, as `pricing_page`.

**`/start-trial` events.** `start_trial_viewed` (once per page load) and `start_trial_checkout_started` (the button), both with `metadata.source` and `metadata.kind` (`trial`, or `pay` for an address that had a subscription). Read them against `checkout_link_created` to see where each entry point's visitors stop.

**Deploy order.** Either order is safe. The site already stores any slug it gets on an intent (as `trial_source` before the site change, `checkout_source` after it) and ignores `?source=` on the pricing page until it knows it. Deploying the site first means every Cloud checkout lands in `checkout_source` from the first minute.

## Weekly report

**Cloud database:** eligible workspaces by the week they became eligible, and how far each got.

```sql
WITH eligible AS (
  SELECT organization_id, min(created_at) AS eligible_at
  FROM product_events
  WHERE event = 'card_trial_offer_eligible'
  GROUP BY 1
),
steps AS (
  SELECT organization_id,
         bool_or(event = 'card_trial_offer_shown')     AS shown,
         bool_or(event = 'card_trial_offer_clicked')   AS clicked,
         bool_or(event = 'card_trial_offer_dismissed') AS dismissed,
         bool_or(event = 'card_trial_offer_emailed')   AS emailed,
         bool_or(event = 'checkout_link_created' AND metadata->>'via' LIKE 'first_success%') AS checkout_opened
  FROM product_events
  WHERE event IN ('card_trial_offer_shown', 'card_trial_offer_clicked', 'card_trial_offer_dismissed',
                  'card_trial_offer_emailed', 'checkout_link_created')
  GROUP BY 1
),
subscribed AS (
  -- Any Stripe licence after the offer, from any entry point (card trial or paid).
  SELECT e.organization_id
  FROM eligible e
  JOIN licenses l ON l.organization_id = e.organization_id
  WHERE l.plan <> 'trial' AND l.created_at >= e.eligible_at
  GROUP BY 1
)
SELECT date_trunc('week', e.eligible_at)::date            AS week,
       count(*)                                            AS eligible,
       count(*) FILTER (WHERE s.shown)                     AS shown,
       count(*) FILTER (WHERE s.clicked)                   AS clicked,
       count(*) FILTER (WHERE s.dismissed)                 AS dismissed,
       count(*) FILTER (WHERE s.emailed)                   AS emailed,
       count(*) FILTER (WHERE s.checkout_opened)           AS checkout_opened,
       count(sub.organization_id)                          AS subscribed_any_source
FROM eligible e
LEFT JOIN steps s USING (organization_id)
LEFT JOIN subscribed sub USING (organization_id)
GROUP BY 1
ORDER BY 1 DESC;
```

**Cloud database, every entry point:** how far each source's visitors got over the last week.

```sql
SELECT coalesce(metadata->>'source', metadata->>'via')                           AS source,
       count(*) FILTER (WHERE event = 'start_trial_viewed')                     AS start_trial_views,
       count(*) FILTER (WHERE event = 'start_trial_checkout_started')           AS start_trial_clicks,
       count(*) FILTER (WHERE event = 'checkout_link_created')                  AS checkout_links,
       count(*) FILTER (WHERE event = 'checkout_link_created'
                          AND metadata->>'kind' = 'trial')                      AS card_trial_links
FROM product_events
WHERE event IN ('start_trial_viewed', 'start_trial_checkout_started', 'checkout_link_created')
  AND created_at >= now() - interval '7 days'
GROUP BY 1
ORDER BY checkout_links DESC;
```

**Stripe, every entry point:** Checkout Sessions of the last week by `checkout_source`, and how many completed. Sessions have no Search API, so the script lists them (100 per page). Run with the licence site's Stripe secret key in `STRIPE_KEY`; `SINCE` is a Unix time (`date -v-7d +%s` on macOS, `date -d '7 days ago' +%s` on Linux).

```bash
after=""
while :; do
  page=$(curl -sG https://api.stripe.com/v1/checkout/sessions -u "$STRIPE_KEY:" \
    -d limit=100 -d "created[gte]=$SINCE" ${after:+-d starting_after=$after})
  echo "$page" | jq -c '.data[] | select(.metadata.app == "anythingmcp")'
  [ "$(echo "$page" | jq -r .has_more)" = true ] || break
  after=$(echo "$page" | jq -r '.data[-1].id')
done |
jq -rs 'group_by(.metadata.checkout_source // .metadata.trial_source // "(none)")[]
  | [ (.[0].metadata.checkout_source // .metadata.trial_source // "(none)"),
      length,
      (map(select(.status == "complete")) | length),
      (map(select(.metadata.trial == "1")) | length),
      (map(select(.metadata.trial == "1" and .status == "complete")) | length) ]
  | @tsv' |
(echo -e "source\tsessions\tcompleted\ttrial_sessions\ttrials_completed"; cat)
```

`(none)` is a session from before the change. Subscriptions are searchable directly: `metadata['checkout_source']:'first_success_email'`.

**Stripe, the offer:** card trials started from the offer, and how many of them paid after the trial, by the week the subscription was created. Run with the licence site's Stripe secret key in `STRIPE_KEY` (the Search API returns at most 100 rows per page; follow `next_page` when `has_more` is true).

```bash
curl -sG https://api.stripe.com/v1/subscriptions/search -u "$STRIPE_KEY:" \
  --data-urlencode "query=metadata['checkout_source']:'first_success_banner' OR metadata['checkout_source']:'first_success_email' OR metadata['trial_source']:'first_success'" \
  -d limit=100 -d 'expand[]=data.latest_invoice' |
jq -r --argjson now "$(date +%s)" '
  [.data[] | {
     week: (.created | strftime("%G-W%V")),
     card_trial: (.trial_end != null),
     trial_over: ((.trial_end // 0) < $now),
     paid: ((.latest_invoice.amount_paid // 0) > 0)
   }]
  | group_by(.week)[]
  | [ .[0].week,
      (map(select(.card_trial)) | length),
      (map(select(.card_trial and .trial_over)) | length),
      (map(select(.card_trial and .trial_over and .paid)) | length) ]
  | @tsv' |
(echo -e "week\tcard_trials_started\ttrials_ended\tpaid_after_trial"; cat)
```

`paid_after_trial` counts subscriptions whose latest invoice, the first one after the trial, was paid with a non-zero amount. `metadata.organizationId` on each subscription joins it back to the workspace and its `card_trial_offer_eligible` week.

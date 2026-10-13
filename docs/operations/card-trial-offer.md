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

The button opens `/start-trial?source=first_success`. "Not now" hides the card for three days on every page (localStorage, per user). Events: `card_trial_offer_shown` (once a day per user and browser), `card_trial_offer_clicked`, `card_trial_offer_dismissed`, each with `metadata.via` = `dashboard`, `connectors` or `connect`.

**Email.** The hourly Cloud onboarding cron runs `CardTrialOfferService.runEmailPass` after its trial-lifecycle and win-back passes. One email per workspace, to its active, verified admins who did not unsubscribe and whose address never had a subscription (without an answer from the licence site the email waits for the next run), between 30 minutes and 48 hours after it became eligible (30 to 90 minutes in practice). It is checked again at send time and is not sent once the workspace started a card trial, pays, or its trial ended. It waits while another email went out in the last 12 hours: a trial-lifecycle or win-back email to the workspace (`org_settings.trial_email_*`), or an onboarding or activation nudge to one of its admins (`users.onboarding_last_reminder_at`, `users.activation_reminder_at`). `org_settings.card_trial_offer_email` settles it: the send time, or `skipped:<reason>` (`customer`, `trial_ended`, `no_trial`, `no_recipient`, `no_trial_recipient`). A failed send is retried by the next run inside the window. Sent emails record `card_trial_offer_emailed` (`metadata.kind` = `trial`, or `plan` when under 48 hours were left and the email linked to the plans instead).

The email talks about value only (the connection works, up to three things to ask next, taken from the connector's own tools, the trial's end date and a link back to the app), never about cards, charges or prices, and it carries the unsubscribe line. Nothing of the offer is ever part of an MCP tool response.

## Attribution to Stripe

1. `/start-trial?source=first_success` sends `source: "first_success"` with `POST /api/license/checkout-link`. The backend accepts only known sources and records `checkout_link_created` (`metadata.via` = the source, or `app` for every other entry point; `metadata.kind` = `trial` or `pay`).
2. The backend passes `source` to the licence site's `POST /api/stripe/checkout-intent`, which stores it on the intent.
3. The site writes it to the Stripe Checkout Session and to the subscription as `metadata.trial_source = "first_success"`.

A licence site without step 2 ignores the field, so the backend can be deployed first.

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
         bool_or(event = 'checkout_link_created' AND metadata->>'via' = 'first_success') AS checkout_opened
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

**Stripe:** card trials started from the offer, and how many of them paid after the trial, by the week the subscription was created. Run with the licence site's Stripe secret key in `STRIPE_KEY` (the Search API returns at most 100 rows per page; follow `next_page` when `has_more` is true).

```bash
curl -sG https://api.stripe.com/v1/subscriptions/search -u "$STRIPE_KEY:" \
  --data-urlencode "query=metadata['trial_source']:'first_success'" \
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

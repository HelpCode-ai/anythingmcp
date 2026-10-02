-- The Stripe subscription state the licence site reports for a paid Cloud
-- licence (trial end, cancelled at period end, renewal date, price), so the
-- app can tell the customer when their plan renews or ends. Nullable and
-- additive: the previous release ignores it during a blue/green switch.
ALTER TABLE "licenses" ADD COLUMN "billing" JSONB;

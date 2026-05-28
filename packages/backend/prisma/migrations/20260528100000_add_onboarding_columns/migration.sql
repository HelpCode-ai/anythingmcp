-- Onboarding state for the in-app welcome wizard and the email drip.
-- Both gates read these columns; only the welcome wizard / drip cron
-- writes to them.

ALTER TABLE "users"
  ADD COLUMN "onboarding_completed_at"   TIMESTAMP(3),
  ADD COLUMN "onboarding_last_reminder_at" TIMESTAMP(3),
  ADD COLUMN "onboarding_reminder_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "email_marketing_opt_out"   BOOLEAN  NOT NULL DEFAULT false;

-- Used by the cron to select candidates efficiently.
CREATE INDEX "users_onboarding_drip_idx"
  ON "users" ("email_verified", "onboarding_completed_at", "email_marketing_opt_out", "created_at");

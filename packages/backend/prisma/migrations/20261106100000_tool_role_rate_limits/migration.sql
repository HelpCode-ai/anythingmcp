ALTER TABLE "tool_role_access"
  ADD COLUMN "calls_per_minute" INTEGER,
  ADD COLUMN "calls_per_hour" INTEGER,
  ADD CONSTRAINT "tool_role_access_calls_per_minute_positive"
    CHECK ("calls_per_minute" IS NULL OR "calls_per_minute" > 0),
  ADD CONSTRAINT "tool_role_access_calls_per_hour_positive"
    CHECK ("calls_per_hour" IS NULL OR "calls_per_hour" > 0);

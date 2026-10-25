-- One address, one account, enforced by the database.
--
-- The application writes addresses trimmed and lower-cased and looks them up
-- ignoring case (common/email.util.ts), and 20261019120000_normalize_user_emails
-- rewrote the existing rows. Accounts that only differed in case have been
-- merged by hand since, so every stored address is now normalised.
--
-- This check keeps it that way: together with the existing unique index on
-- "email", an address that is stored normalised can only exist once in any
-- case. A write path that forgets to normalise fails loudly here instead of
-- silently creating a second account.
--
-- A CHECK constraint rather than a unique index on lower("email"): Prisma
-- cannot describe expression indexes and would try to drop one on the next
-- `migrate dev`, while it leaves check constraints alone.
--
-- Only added when every row already satisfies it. A self-hosted install can
-- still hold case-variant duplicates that the previous migration left alone
-- on purpose; a failing migration would keep the app from starting, so there
-- it is skipped with a notice. Merge the rows listed by
-- scripts/report-duplicate-emails.sql, then add the constraint by hand with
-- the ALTER TABLE below.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "users" WHERE "email" <> lower(btrim("email"))) THEN
    RAISE NOTICE 'users_email_normalised_check not added: some addresses are not normalised (see scripts/report-duplicate-emails.sql)';
  ELSIF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_email_normalised_check') THEN
    ALTER TABLE "users"
      ADD CONSTRAINT "users_email_normalised_check"
      CHECK ("email" = lower(btrim("email")));
  END IF;
END
$$;

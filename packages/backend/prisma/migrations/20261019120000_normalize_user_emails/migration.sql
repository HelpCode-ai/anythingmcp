-- Normalise stored email addresses (trimmed, lower case).
--
-- Addresses used to be stored exactly as typed and looked up the same way, so
-- `Name@Example.com` and `name@example.com` could become two accounts. The
-- application now writes addresses normalised and looks them up ignoring
-- case; this brings the existing rows in line.
--
-- A row is only rewritten when no OTHER row has the same address in another
-- case. Rows that do collide are left exactly as they are: they are separate
-- accounts that an operator has to merge by hand (list them with
-- scripts/report-duplicate-emails.sql). Nothing is merged or deleted here,
-- and `updated_at` is not touched.
--
-- The unique index on "users"."email" stays case-sensitive for now; a unique
-- index on lower("email") can only be added once the duplicates are merged.
UPDATE "users" AS u
SET "email" = lower(btrim(u."email"))
WHERE u."email" <> lower(btrim(u."email"))
  AND NOT EXISTS (
    SELECT 1
    FROM "users" AS o
    WHERE o."id" <> u."id"
      AND lower(btrim(o."email")) = lower(btrim(u."email"))
  );

-- Invitations are not unique per address, so every one can be normalised.
UPDATE "invitation_tokens"
SET "email" = lower(btrim("email"))
WHERE "email" <> lower(btrim("email"));

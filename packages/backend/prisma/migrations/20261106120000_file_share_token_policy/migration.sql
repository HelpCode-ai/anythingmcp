-- File Share link lookup without a workspace context (#1418).
-- A public or internal link carries only its token, so the workspace is not
-- known until the row is read. FileSearchRepository.withShareToken sets
-- app.share_token_hash (transaction-local) to the SHA-256 of the token and
-- reads the row; this policy shows exactly the row with that hash, and only
-- to someone who already holds its secret token.
--
-- FOR SELECT only: permissive policies are ORed per command, so this policy
-- adds nothing to INSERT, UPDATE or DELETE, which still need org_isolation
-- (app.current_org). An unset setting is NULL and an emptied one is '', and
-- NULLIF turns both into NULL: the comparison is then never true.
DROP POLICY IF EXISTS share_by_token ON "file_shares";
CREATE POLICY share_by_token ON "file_shares"
  AS PERMISSIVE
  FOR SELECT
  USING ("token_hash" = NULLIF(current_setting('app.share_token_hash', true), ''));

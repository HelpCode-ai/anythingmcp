-- Revoking a connection must NARROW it. Deleting the grant row would mean "no
-- grant", and no grant means the pre-grant behaviour — the caller's entire
-- organization — so a delete would have widened access instead of removing it.
-- The row is kept and stamped instead.

-- AlterTable
ALTER TABLE "mcp_connection_grants" ADD COLUMN     "revoked_at" TIMESTAMP(3);

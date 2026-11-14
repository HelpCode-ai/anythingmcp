-- Built without locking kg_edges for writes. CONCURRENTLY cannot run inside a
-- transaction block, so this migration holds this one statement only.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "kg_edges_target_node_id_idx" ON "kg_edges"("target_node_id");

-- =============================================================================
-- Migration: kg_value_seen rows belong to their connector
-- =============================================================================
-- kg_value_seen.connector_id had no foreign key, so deleting a connector left
-- its value hashes behind (102 deleted connectors, 57.5k rows on cloud by
-- 21 Oct 2026). The observational ingest kept pairing fresh values with them
-- and tried to create kg_nodes for the deleted connector, which Postgres
-- refused on kg_nodes_connector_id_fkey some 21.8k times a day.
--
-- Delete the orphans, then add the foreign key with ON DELETE CASCADE plus an
-- index on connector_id, so the cascade does not scan the whole table every
-- time a connector is deleted.
--
-- Locking: the migration runs as one transaction. On cloud (2.7 M rows,
-- 1.5 GB) the orphan scan takes under a second and the index build about
-- four. CREATE INDEX blocks writes to kg_value_seen only (the KG ingest runs
-- in the background and retries on the next call). The foreign key is added
-- NOT VALID, which is instant, so "connectors" is locked against writes only
-- for the short second delete and VALIDATE that follow. The second delete
-- removes rows of a connector deleted between the first one and the moment
-- the constraint started to apply.
-- =============================================================================

DELETE FROM "kg_value_seen" v
WHERE NOT EXISTS (SELECT 1 FROM "connectors" c WHERE c."id" = v."connector_id");

CREATE INDEX "kg_value_seen_connector_id_idx" ON "kg_value_seen"("connector_id");

ALTER TABLE "kg_value_seen"
    ADD CONSTRAINT "kg_value_seen_connector_id_fkey"
    FOREIGN KEY ("connector_id") REFERENCES "connectors"("id")
    ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;

DELETE FROM "kg_value_seen" v
WHERE NOT EXISTS (SELECT 1 FROM "connectors" c WHERE c."id" = v."connector_id");

ALTER TABLE "kg_value_seen" VALIDATE CONSTRAINT "kg_value_seen_connector_id_fkey";

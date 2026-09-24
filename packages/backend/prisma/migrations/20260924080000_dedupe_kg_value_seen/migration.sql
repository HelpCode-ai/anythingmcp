-- =============================================================================
-- Migration: one kg_value_seen row per distinct occurrence
-- =============================================================================
-- The observational KG ingest inserted a row every time it saw a value, and a
-- run that never reached its watermark re-read the same invocations over and
-- over. On cloud 5.8 M of 6.1 M rows were copies, and correlate() read every
-- copy back. Keep the earliest row of each occurrence, then make the
-- occurrence unique so createMany(skipDuplicates) keeps it that way.
--
-- Large installations: run the DELETE by hand first (it is idempotent) so the
-- migration itself only has the handful of rows written since.
-- =============================================================================

DELETE FROM "kg_value_seen"
WHERE "id" IN (
    SELECT "id" FROM (
        SELECT "id",
               row_number() OVER (
                   PARTITION BY "organization_id", "connector_id", "value_hash", "entity", "field", "direction"
                   ORDER BY "seen_at", "id"
               ) AS rn
        FROM "kg_value_seen"
    ) ranked
    WHERE ranked.rn > 1
);

CREATE UNIQUE INDEX "kg_value_seen_occurrence_key"
    ON "kg_value_seen"("organization_id", "connector_id", "value_hash", "entity", "field", "direction");

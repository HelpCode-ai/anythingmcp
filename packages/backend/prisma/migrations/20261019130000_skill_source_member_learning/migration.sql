-- Where a workspace skill came from, so skill generation only replaces its
-- own pending suggestions (it used to delete skills filed by the Agent Skills
-- Finder and manual pending ones too).
ALTER TABLE "kg_skill_suggestions" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'manual';

-- Backfill. Finder skills end with the "Source: <url> (licence: …)" line that
-- skills_save_to_workspace appends; manual skills are created with
-- confidence 1, generated and consolidated ones carry the model's score.
UPDATE "kg_skill_suggestions"
SET "source" = 'finder'
WHERE "instruction" ~ E'\n\nSource: https?://\\S+ \\(licence: [^)]*\\)$';

UPDATE "kg_skill_suggestions"
SET "source" = 'llm'
WHERE "source" = 'manual' AND "confidence" < 1;

-- Per-member control over skill learning (intent capture).
ALTER TABLE "organization_members" ADD COLUMN "learning_mode" TEXT NOT NULL DEFAULT 'inherit';
ALTER TABLE "organization_members" ADD COLUMN "learning_opt_out" BOOLEAN NOT NULL DEFAULT false;

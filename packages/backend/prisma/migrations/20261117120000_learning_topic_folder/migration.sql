-- Learning projects: a topic can file its skills in its own folder (#1770).
-- Additive: a nullable column, its index and foreign key. Null keeps today's
-- behaviour (the project's folder).
ALTER TABLE "learning_topics" ADD COLUMN "folder_id" TEXT;

CREATE INDEX "learning_topics_folder_id_idx" ON "learning_topics"("folder_id");

ALTER TABLE "learning_topics" ADD CONSTRAINT "learning_topics_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "knowledge_folders"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

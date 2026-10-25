-- One folder tree per workspace, shared by skills and the company memory.
-- `role_ids` limits a folder and its subtree to members holding one of those
-- custom roles; empty = the whole workspace. Nothing is moved into folders.
CREATE TABLE "knowledge_folders" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "parent_id" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "role_ids" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_folders_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "knowledge_folders_organization_id_idx" ON "knowledge_folders"("organization_id");
CREATE INDEX "knowledge_folders_parent_id_idx" ON "knowledge_folders"("parent_id");

ALTER TABLE "knowledge_folders" ADD CONSTRAINT "knowledge_folders_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Folder deletion is done by the application (children and items move to the
-- parent first). NO ACTION everywhere: a child or item added meanwhile makes
-- the delete fail instead of being cascaded away or set to the top level
-- (which could widen who sees it). Deleting a workspace still works: every
-- row cascades from the organization in the same statement.
ALTER TABLE "knowledge_folders" ADD CONSTRAINT "knowledge_folders_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "knowledge_folders"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "kg_skill_suggestions" ADD COLUMN "folder_id" TEXT;
ALTER TABLE "kg_skill_suggestions" ADD CONSTRAINT "kg_skill_suggestions_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "knowledge_folders"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "memory_items" ADD COLUMN "folder_id" TEXT;
ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "knowledge_folders"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

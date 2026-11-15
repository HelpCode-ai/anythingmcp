-- Learning projects (#1695): learning turned on for one member on one MCP
-- server. Additive and inert: nothing reads these tables until a project
-- exists. Every new column has a constant default (a catalog-only change in
-- Postgres, no table rewrite).

CREATE TABLE "learning_projects" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "user_id" TEXT,
    "mcp_server_id" TEXT,
    "folder_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "publish_mode" TEXT NOT NULL DEFAULT 'manual',
    "tags" JSONB NOT NULL DEFAULT '[]',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "starts_at" TIMESTAMP(3),
    "ends_at" TIMESTAMP(3),
    "consent_at" TIMESTAMP(3),
    "consent_notice" TEXT,
    "created_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "learning_projects_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "learning_topics" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "when_to_use" TEXT NOT NULL DEFAULT '',
    "draft_skill_id" TEXT,
    "published_skill_id" TEXT,
    "published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "learning_topics_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "learning_lessons" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "topic_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "text_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "superseded_by_id" TEXT,
    "source" TEXT NOT NULL DEFAULT 'model',
    "seen_count" INTEGER NOT NULL DEFAULT 1,
    "confirmed_at" TIMESTAMP(3),
    "confirmed_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "learning_lessons_pkey" PRIMARY KEY ("id")
);

-- Learned skills: where they come from and who is served a draft.
ALTER TABLE "kg_skill_suggestions" ADD COLUMN "learning_project_id" TEXT;
ALTER TABLE "kg_skill_suggestions" ADD COLUMN "origin_user_id" TEXT;
ALTER TABLE "kg_skill_suggestions" ADD COLUMN "audience_user_id" TEXT;
ALTER TABLE "kg_skill_suggestions" ADD COLUMN "tags" JSONB NOT NULL DEFAULT '[]';

CREATE INDEX "learning_projects_organization_id_status_idx" ON "learning_projects"("organization_id", "status");
CREATE INDEX "learning_projects_user_id_mcp_server_id_idx" ON "learning_projects"("user_id", "mcp_server_id");
CREATE INDEX "learning_topics_organization_id_idx" ON "learning_topics"("organization_id");
CREATE UNIQUE INDEX "learning_topics_project_id_key_key" ON "learning_topics"("project_id", "key");
CREATE INDEX "learning_lessons_project_id_status_idx" ON "learning_lessons"("project_id", "status");
CREATE INDEX "learning_lessons_organization_id_idx" ON "learning_lessons"("organization_id");
CREATE UNIQUE INDEX "learning_lessons_topic_id_text_hash_key" ON "learning_lessons"("topic_id", "text_hash");
CREATE INDEX "kg_skill_suggestions_audience_user_id_idx" ON "kg_skill_suggestions"("audience_user_id");

ALTER TABLE "learning_projects" ADD CONSTRAINT "learning_projects_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- The lessons outlive the member's account and the server they were learned on.
ALTER TABLE "learning_projects" ADD CONSTRAINT "learning_projects_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "learning_projects" ADD CONSTRAINT "learning_projects_mcp_server_id_fkey" FOREIGN KEY ("mcp_server_id") REFERENCES "mcp_server_configs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- NO ACTION like the other folder links: the folder service moves a project
-- to the parent folder before it deletes a folder.
ALTER TABLE "learning_projects" ADD CONSTRAINT "learning_projects_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "knowledge_folders"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "learning_topics" ADD CONSTRAINT "learning_topics_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "learning_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "learning_topics" ADD CONSTRAINT "learning_topics_draft_skill_id_fkey" FOREIGN KEY ("draft_skill_id") REFERENCES "kg_skill_suggestions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "learning_topics" ADD CONSTRAINT "learning_topics_published_skill_id_fkey" FOREIGN KEY ("published_skill_id") REFERENCES "kg_skill_suggestions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "learning_lessons" ADD CONSTRAINT "learning_lessons_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "learning_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "learning_lessons" ADD CONSTRAINT "learning_lessons_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "learning_topics"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "kg_skill_suggestions" ADD CONSTRAINT "kg_skill_suggestions_learning_project_id_fkey" FOREIGN KEY ("learning_project_id") REFERENCES "learning_projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "kg_skill_suggestions" ADD CONSTRAINT "kg_skill_suggestions_origin_user_id_fkey" FOREIGN KEY ("origin_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- A draft is served to one member only; it goes with that member.
ALTER TABLE "kg_skill_suggestions" ADD CONSTRAINT "kg_skill_suggestions_audience_user_id_fkey" FOREIGN KEY ("audience_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

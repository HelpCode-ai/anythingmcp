-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'EDITOR', 'VIEWER');

-- CreateEnum
CREATE TYPE "ConnectorType" AS ENUM ('REST', 'SOAP', 'GRAPHQL', 'MCP', 'DATABASE', 'WEBHOOK');

-- CreateEnum
CREATE TYPE "AuthType" AS ENUM ('NONE', 'API_KEY', 'BEARER_TOKEN', 'BASIC_AUTH', 'OAUTH2', 'WS_SECURITY', 'CERTIFICATE', 'CONNECTION_STRING', 'HMAC');

-- CreateEnum
CREATE TYPE "InvocationStatus" AS ENUM ('SUCCESS', 'ERROR', 'TIMEOUT');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "name" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'EDITOR',
    "ai_provider" TEXT,
    "ai_api_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connectors" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "ConnectorType" NOT NULL,
    "base_url" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "auth_type" "AuthType" NOT NULL DEFAULT 'NONE',
    "auth_config" TEXT,
    "spec_url" TEXT,
    "spec_data" JSONB,
    "headers" JSONB,
    "config" JSONB,
    "env_vars" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "connectors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_tools" (
    "id" TEXT NOT NULL,
    "connector_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "parameters" JSONB NOT NULL,
    "endpoint_mapping" JSONB NOT NULL,
    "response_mapping" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mcp_tools_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_resources" (
    "id" TEXT NOT NULL,
    "connector_id" TEXT NOT NULL,
    "uri" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "mime_type" TEXT NOT NULL DEFAULT 'application/json',
    "fetch_config" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mcp_resources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_prompts" (
    "id" TEXT NOT NULL,
    "connector_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "template" TEXT NOT NULL,
    "arguments" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mcp_prompts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_server_configs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'My MCP Server',
    "version" TEXT NOT NULL DEFAULT '1.0.0',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "auth_type" "AuthType" NOT NULL DEFAULT 'BEARER_TOKEN',
    "auth_config" TEXT,
    "transport" TEXT NOT NULL DEFAULT 'streamable-http',
    "endpoint" TEXT NOT NULL DEFAULT '/mcp',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mcp_server_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tool_invocations" (
    "id" TEXT NOT NULL,
    "tool_id" TEXT NOT NULL,
    "user_id" TEXT,
    "input" JSONB NOT NULL,
    "output" JSONB,
    "status" "InvocationStatus" NOT NULL,
    "duration_ms" INTEGER,
    "error" TEXT,
    "client_info" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tool_invocations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "mcp_tools_connector_id_name_key" ON "mcp_tools"("connector_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "mcp_resources_connector_id_uri_key" ON "mcp_resources"("connector_id", "uri");

-- CreateIndex
CREATE UNIQUE INDEX "mcp_prompts_connector_id_name_key" ON "mcp_prompts"("connector_id", "name");

-- CreateIndex
CREATE INDEX "tool_invocations_tool_id_created_at_idx" ON "tool_invocations"("tool_id", "created_at");

-- CreateIndex
CREATE INDEX "tool_invocations_user_id_created_at_idx" ON "tool_invocations"("user_id", "created_at");

-- AddForeignKey
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_tools" ADD CONSTRAINT "mcp_tools_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_resources" ADD CONSTRAINT "mcp_resources_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_prompts" ADD CONSTRAINT "mcp_prompts_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_server_configs" ADD CONSTRAINT "mcp_server_configs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_tool_id_fkey" FOREIGN KEY ("tool_id") REFERENCES "mcp_tools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

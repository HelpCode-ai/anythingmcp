-- CreateEnum
CREATE TYPE "McpApiKeyScope" AS ENUM ('MCP', 'MANAGEMENT_READ', 'MANAGEMENT_ADMIN');

-- AlterTable
ALTER TABLE "mcp_api_keys" ADD COLUMN     "scope" "McpApiKeyScope" NOT NULL DEFAULT 'MCP';

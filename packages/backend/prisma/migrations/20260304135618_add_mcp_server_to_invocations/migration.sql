-- AlterTable
ALTER TABLE "tool_invocations" ADD COLUMN "mcp_server_id" TEXT;

-- AddForeignKey
ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_mcp_server_id_fkey" FOREIGN KEY ("mcp_server_id") REFERENCES "mcp_server_configs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "tool_invocations_mcp_server_id_created_at_idx" ON "tool_invocations"("mcp_server_id", "created_at");

-- MCP groups the agent loaded on top of the per-phase defaults (string array).
-- AlterTable
ALTER TABLE "chat" ADD COLUMN     "loadedMcpGroups" JSONB;

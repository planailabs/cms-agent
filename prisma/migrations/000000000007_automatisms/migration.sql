-- Archived chats leave the sidebar; listed in the archive view until deleted
ALTER TABLE "chat" ADD COLUMN "archivedAt" TIMESTAMP(3);

-- Agent-less flows attached to a chat (deploy pipeline etc.)
CREATE TABLE "automatism" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "step" INTEGER NOT NULL DEFAULT 0,
    "data" JSONB NOT NULL,
    "agentChatId" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automatism_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "automatism_chatId_idx" ON "automatism"("chatId");

-- CreateIndex
CREATE INDEX "automatism_agentChatId_idx" ON "automatism"("agentChatId");

-- AddForeignKey
ALTER TABLE "automatism" ADD CONSTRAINT "automatism_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

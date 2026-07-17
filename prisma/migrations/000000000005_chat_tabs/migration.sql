-- Per-user open preview tabs of a chat (synced across sessions via SSE)
CREATE TABLE "chat_tabs" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tabs" JSONB NOT NULL,
    "activeIndex" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_tabs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "chat_tabs_chatId_userId_key" ON "chat_tabs"("chatId", "userId");

-- AddForeignKey
ALTER TABLE "chat_tabs" ADD CONSTRAINT "chat_tabs_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_tabs" ADD CONSTRAINT "chat_tabs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Per-chat agent task list (display text + agent-only note + status).
CREATE TABLE "chat_task" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'todo',
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_task_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "chat_task_chatId_idx" ON "chat_task"("chatId");

ALTER TABLE "chat_task" ADD CONSTRAINT "chat_task_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

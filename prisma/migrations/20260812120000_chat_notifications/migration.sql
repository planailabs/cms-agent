-- Per-chat "tell me when it stops working" subscriptions, plus the phone
-- number they need (SSO gives us an email, never a number).

-- AlterTable
ALTER TABLE "user" ADD COLUMN     "phone" TEXT;

-- CreateTable
CREATE TABLE "chat_notification" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "channels" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chat_notification_chatId_idx" ON "chat_notification"("chatId");

-- CreateIndex
CREATE UNIQUE INDEX "chat_notification_chatId_userId_key" ON "chat_notification"("chatId", "userId");

-- AddForeignKey
ALTER TABLE "chat_notification" ADD CONSTRAINT "chat_notification_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_notification" ADD CONSTRAINT "chat_notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Chat attachments: scope uploads to a chat and link them to the message they
-- were sent with; global editorial uploads keep chatId/messageId NULL.
ALTER TABLE "upload" ADD COLUMN "chatId" TEXT;
ALTER TABLE "upload" ADD COLUMN "messageId" TEXT;

CREATE INDEX "upload_chatId_idx" ON "upload"("chatId");
CREATE INDEX "upload_messageId_idx" ON "upload"("messageId");

ALTER TABLE "upload" ADD CONSTRAINT "upload_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "upload" ADD CONSTRAINT "upload_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Global app-wide settings (admin toggles), keyed by a stable string.
CREATE TABLE "app_setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_setting_pkey" PRIMARY KEY ("key")
);

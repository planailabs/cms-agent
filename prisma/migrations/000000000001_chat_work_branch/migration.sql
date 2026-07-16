-- Chats get their own git work branch (own worktree + preview subdomain)
-- that merges into the target branch. Backfill derives a DNS-safe label
-- from the chat id (cuid: lowercase alphanumerics).
ALTER TABLE "chat" ADD COLUMN "workBranch" TEXT;

UPDATE "chat" SET "workBranch" = 'c-' || substr("id", 1, 12);

ALTER TABLE "chat" ALTER COLUMN "workBranch" SET NOT NULL;

CREATE UNIQUE INDEX "chat_workBranch_key" ON "chat"("workBranch");

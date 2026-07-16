-- Recovery migration: 000000000003_chat_kind was edited AFTER it had been
-- applied — the DROP NOT NULL below was added to that file once the DB had
-- already recorded it, so it never executed. Re-issue it here; on fresh
-- databases (where 0003 ran in full) this is a no-op.
ALTER TABLE "chat" ALTER COLUMN "createdById" DROP NOT NULL;

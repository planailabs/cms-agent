-- Explicit plan mode, switched on per chat by the /plan command: the agent
-- proposes a plan and waits for approval instead of recording it and going on.
ALTER TABLE "chat" ADD COLUMN "planMode" BOOLEAN NOT NULL DEFAULT false;

-- The command a message was sent with, so the transcript can still show the
-- chip (and explain why the chat behaved differently) long afterwards.
ALTER TABLE "message" ADD COLUMN "command" TEXT;

-- Autonomy grants are gone. Their only consumer was the auto-approval of a
-- pending propose_plan; once plans stopped being submitted for approval by
-- default, nothing could ever consume a grant again.
DROP TABLE IF EXISTS "autonomy_grant";

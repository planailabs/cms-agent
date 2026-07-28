-- Reviewing is part of EXECUTE now: the separate PREVIEW phase was merged into
-- it, so chats parked in preview continue in execute (their work is committed
-- and the publish action stays available there).
UPDATE "chat" SET "workflowPhase" = 'execute' WHERE "workflowPhase" = 'preview';

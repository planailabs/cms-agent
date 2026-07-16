-- System chats (kind 'deployments') talk about publication state instead of
-- driving the plan/execute/preview/publish workflow.
ALTER TABLE "chat" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'workflow';

-- System chats have no CMS creator
ALTER TABLE "chat" ALTER COLUMN "createdById" DROP NOT NULL;

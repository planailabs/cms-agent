-- Branches synced from the git repo (incl. the default branch) have no
-- CMS creator.
ALTER TABLE "branch" ALTER COLUMN "createdById" DROP NOT NULL;

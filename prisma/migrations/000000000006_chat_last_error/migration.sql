-- Last failed turn's error — shown with a Retry button until cleared
ALTER TABLE "chat" ADD COLUMN "lastError" TEXT;

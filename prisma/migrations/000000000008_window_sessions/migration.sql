-- Soft window sessions: per-window view-state blobs, offered/restorable on load
CREATE TABLE "window_session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "state" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "window_session_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "window_session_userId_updatedAt_idx" ON "window_session"("userId", "updatedAt");

ALTER TABLE "window_session" ADD CONSTRAINT "window_session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

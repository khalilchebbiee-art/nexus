ALTER TABLE "User" ADD COLUMN "lastSeenAt" TIMESTAMP(3);

ALTER TABLE "Message"
ADD COLUMN "replyToId" TEXT,
ADD COLUMN "pinnedAt" TIMESTAMP(3),
ADD COLUMN "pinnedById" TEXT;

ALTER TABLE "Message" ADD CONSTRAINT "Message_replyToId_fkey" FOREIGN KEY ("replyToId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Message_conversationId_pinnedAt_idx" ON "Message"("conversationId", "pinnedAt");

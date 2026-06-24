CREATE TYPE "ConversationType" AS ENUM ('DIRECT', 'GROUP', 'CHANNEL');
CREATE TYPE "ConversationRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');
CREATE TYPE "NotificationType" AS ENUM ('MESSAGE', 'REACTION', 'SCHEDULED', 'SYSTEM');

ALTER TABLE "Conversation"
ADD COLUMN "type" "ConversationType" NOT NULL DEFAULT 'DIRECT',
ADD COLUMN "name" TEXT,
ADD COLUMN "description" TEXT NOT NULL DEFAULT '',
ADD COLUMN "ownerId" TEXT;

ALTER TABLE "ConversationMember"
ADD COLUMN "role" "ConversationRole" NOT NULL DEFAULT 'MEMBER';

ALTER TABLE "Message"
ADD COLUMN "originalMediaUrl" TEXT,
ADD COLUMN "storageProvider" TEXT NOT NULL DEFAULT 'local',
ADD COLUMN "editedAt" TIMESTAMP(3),
ADD COLUMN "deletedAt" TIMESTAMP(3),
ADD COLUMN "scheduledFor" TIMESTAMP(3),
ADD COLUMN "deliveredAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP;

CREATE TABLE "MessageReaction" (
  "id" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "emoji" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MessageReaction_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Notification" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "type" "NotificationType" NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "conversationId" TEXT,
  "messageId" TEXT,
  "readAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Conversation_type_updatedAt_idx" ON "Conversation"("type", "updatedAt");
CREATE INDEX "Message_conversationId_deliveredAt_idx" ON "Message"("conversationId", "deliveredAt");
CREATE INDEX "Message_scheduledFor_deliveredAt_idx" ON "Message"("scheduledFor", "deliveredAt");
CREATE INDEX "MessageReaction_messageId_idx" ON "MessageReaction"("messageId");
CREATE UNIQUE INDEX "MessageReaction_messageId_userId_emoji_key" ON "MessageReaction"("messageId", "userId", "emoji");
CREATE INDEX "Notification_userId_readAt_createdAt_idx" ON "Notification"("userId", "readAt", "createdAt");

ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MessageReaction" ADD CONSTRAINT "MessageReaction_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MessageReaction" ADD CONSTRAINT "MessageReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

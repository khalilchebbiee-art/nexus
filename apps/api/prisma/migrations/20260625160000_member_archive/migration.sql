-- Conversation member: archive (file a chat under "Archived" for this member).
ALTER TABLE "ConversationMember" ADD COLUMN "archivedAt" TIMESTAMP(3);

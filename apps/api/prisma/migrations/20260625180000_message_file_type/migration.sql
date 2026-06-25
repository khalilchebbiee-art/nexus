-- New message type for document/file attachments.
ALTER TYPE "MessageType" ADD VALUE IF NOT EXISTS 'FILE';

-- Original filename for file attachments (display only).
ALTER TABLE "Message" ADD COLUMN "fileName" TEXT;

-- Phase 3: calling infrastructure
CREATE TYPE "CallType" AS ENUM ('AUDIO', 'VIDEO');
CREATE TYPE "CallStatus" AS ENUM ('RINGING', 'ONGOING', 'ENDED', 'MISSED', 'DECLINED', 'FAILED');

CREATE TABLE "CallSession" (
  "id" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "callerId" TEXT NOT NULL,
  "type" "CallType" NOT NULL DEFAULT 'AUDIO',
  "status" "CallStatus" NOT NULL DEFAULT 'RINGING',
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "answeredAt" TIMESTAMP(3),
  "endedAt" TIMESTAMP(3),
  "durationSec" INTEGER NOT NULL DEFAULT 0,
  "endedReason" TEXT,
  "recordingUrl" TEXT,
  CONSTRAINT "CallSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CallParticipant" (
  "id" TEXT NOT NULL,
  "callId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "joinedAt" TIMESTAMP(3),
  "leftAt" TIMESTAMP(3),
  CONSTRAINT "CallParticipant_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CallSession_conversationId_startedAt_idx" ON "CallSession"("conversationId", "startedAt");
CREATE INDEX "CallSession_callerId_startedAt_idx" ON "CallSession"("callerId", "startedAt");
CREATE UNIQUE INDEX "CallParticipant_callId_userId_key" ON "CallParticipant"("callId", "userId");
CREATE INDEX "CallParticipant_userId_idx" ON "CallParticipant"("userId");

ALTER TABLE "CallSession" ADD CONSTRAINT "CallSession_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CallSession" ADD CONSTRAINT "CallSession_callerId_fkey" FOREIGN KEY ("callerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CallParticipant" ADD CONSTRAINT "CallParticipant_callId_fkey" FOREIGN KEY ("callId") REFERENCES "CallSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CallParticipant" ADD CONSTRAINT "CallParticipant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

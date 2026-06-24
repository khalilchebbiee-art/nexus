-- Email verification + end-to-end encryption support
ALTER TABLE "User"
ADD COLUMN "publicKey" TEXT,
ADD COLUMN "encryptedPrivateKey" TEXT,
ADD COLUMN "keySalt" TEXT,
ADD COLUMN "keyIv" TEXT;

ALTER TABLE "Message"
ADD COLUMN "encrypted" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "PendingRegistration" (
  "id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "username" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "codeHash" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PendingRegistration_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PendingRegistration_email_key" ON "PendingRegistration"("email");
CREATE INDEX "PendingRegistration_expiresAt_idx" ON "PendingRegistration"("expiresAt");

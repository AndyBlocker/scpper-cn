-- CreateEnum
CREATE TYPE "WikidotBindingStatus" AS ENUM ('PENDING', 'VERIFIED', 'EXPIRED', 'CANCELLED');

-- CreateTable
CREATE TABLE "WikidotBindingTask" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "wikidotUserId" INTEGER NOT NULL,
    "wikidotUsername" TEXT,
    "verificationCode" TEXT NOT NULL,
    "status" "WikidotBindingStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3),
    "checkCount" INTEGER NOT NULL DEFAULT 0,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WikidotBindingTask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WikidotBindingTask_verificationCode_key" ON "WikidotBindingTask"("verificationCode");

-- CreateIndex
CREATE INDEX "WikidotBindingTask_userId_status_idx" ON "WikidotBindingTask"("userId", "status");

-- CreateIndex
CREATE INDEX "WikidotBindingTask_status_expiresAt_idx" ON "WikidotBindingTask"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "WikidotBindingTask_wikidotUserId_idx" ON "WikidotBindingTask"("wikidotUserId");

-- AddForeignKey
ALTER TABLE "WikidotBindingTask" ADD CONSTRAINT "WikidotBindingTask_userId_fkey" FOREIGN KEY ("userId") REFERENCES "UserAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

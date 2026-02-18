-- CreateTable
CREATE TABLE "GachaCardUnlock" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "firstUnlockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GachaCardUnlock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GachaCardUnlock_userId_cardId_key" ON "GachaCardUnlock"("userId", "cardId");

-- CreateIndex
CREATE INDEX "GachaCardUnlock_userId_firstUnlockedAt_idx" ON "GachaCardUnlock"("userId", "firstUnlockedAt");

-- CreateIndex
CREATE INDEX "GachaCardUnlock_cardId_idx" ON "GachaCardUnlock"("cardId");

-- AddForeignKey
ALTER TABLE "GachaCardUnlock" ADD CONSTRAINT "GachaCardUnlock_userId_fkey" FOREIGN KEY ("userId") REFERENCES "UserAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GachaCardUnlock" ADD CONSTRAINT "GachaCardUnlock_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "GachaCardDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable: GachaCardInstance — add lock fields
ALTER TABLE "GachaCardInstance" ADD COLUMN "isLocked" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "GachaCardInstance" ADD COLUMN "lockedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "GachaCardInstance_userId_isLocked_idx" ON "GachaCardInstance"("userId", "isLocked");

-- CreateTable: GachaShowcase
CREATE TABLE "GachaShowcase" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" VARCHAR(30) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GachaShowcase_pkey" PRIMARY KEY ("id")
);

-- CreateTable: GachaShowcaseSlot
CREATE TABLE "GachaShowcaseSlot" (
    "id" TEXT NOT NULL,
    "showcaseId" TEXT NOT NULL,
    "slotIndex" INTEGER NOT NULL,
    "instanceId" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GachaShowcaseSlot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GachaShowcase_userId_sortOrder_idx" ON "GachaShowcase"("userId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "GachaShowcaseSlot_instanceId_key" ON "GachaShowcaseSlot"("instanceId");

-- CreateIndex
CREATE UNIQUE INDEX "GachaShowcaseSlot_showcaseId_slotIndex_key" ON "GachaShowcaseSlot"("showcaseId", "slotIndex");

-- AddForeignKey
ALTER TABLE "GachaShowcase" ADD CONSTRAINT "GachaShowcase_userId_fkey" FOREIGN KEY ("userId") REFERENCES "UserAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GachaShowcaseSlot" ADD CONSTRAINT "GachaShowcaseSlot_showcaseId_fkey" FOREIGN KEY ("showcaseId") REFERENCES "GachaShowcase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GachaShowcaseSlot" ADD CONSTRAINT "GachaShowcaseSlot_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "GachaCardInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

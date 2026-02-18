-- CreateTable
CREATE TABLE "GachaCardInstance" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "affixVisualStyle" "GachaAffixVisualStyle" NOT NULL DEFAULT 'NONE',
    "affixSignature" TEXT NOT NULL DEFAULT 'NONE',
    "affixLabel" TEXT,
    "obtainedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "obtainedVia" TEXT NOT NULL DEFAULT 'DRAW',
    "tradeListingId" TEXT,

    CONSTRAINT "GachaCardInstance_pkey" PRIMARY KEY ("id")
);

-- AddColumn
ALTER TABLE "GachaPlacementSlot" ADD COLUMN "instanceId" TEXT;

-- CreateIndex
CREATE INDEX "GachaCardInstance_userId_cardId_idx" ON "GachaCardInstance"("userId", "cardId");

-- CreateIndex
CREATE INDEX "GachaCardInstance_userId_affixSignature_idx" ON "GachaCardInstance"("userId", "affixSignature");

-- CreateIndex
CREATE INDEX "GachaCardInstance_cardId_idx" ON "GachaCardInstance"("cardId");

-- CreateIndex
CREATE INDEX "GachaCardInstance_tradeListingId_idx" ON "GachaCardInstance"("tradeListingId");

-- CreateIndex
CREATE UNIQUE INDEX "GachaPlacementSlot_instanceId_key" ON "GachaPlacementSlot"("instanceId");

-- AddForeignKey
ALTER TABLE "GachaPlacementSlot" ADD CONSTRAINT "GachaPlacementSlot_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "GachaCardInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GachaCardInstance" ADD CONSTRAINT "GachaCardInstance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "UserAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GachaCardInstance" ADD CONSTRAINT "GachaCardInstance_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "GachaCardDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GachaCardInstance" ADD CONSTRAINT "GachaCardInstance_tradeListingId_fkey" FOREIGN KEY ("tradeListingId") REFERENCES "GachaTradeListing"("id") ON DELETE SET NULL ON UPDATE CASCADE;

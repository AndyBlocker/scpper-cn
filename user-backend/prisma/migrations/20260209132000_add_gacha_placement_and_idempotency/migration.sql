-- CreateTable
CREATE TABLE "GachaPlacementState" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "pendingToken" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "lastAccrualAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GachaPlacementState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GachaPlacementSlot" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "slotIndex" INTEGER NOT NULL,
    "cardId" TEXT,
    "assignedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GachaPlacementSlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiIdempotencyRecord" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "idemKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "responseJson" JSONB NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expireAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApiIdempotencyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GachaPlacementState_userId_key" ON "GachaPlacementState"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "GachaPlacementSlot_userId_slotIndex_key" ON "GachaPlacementSlot"("userId", "slotIndex");

-- CreateIndex
CREATE INDEX "GachaPlacementSlot_cardId_idx" ON "GachaPlacementSlot"("cardId");

-- CreateIndex
CREATE UNIQUE INDEX "ApiIdempotencyRecord_userId_method_path_idemKey_key" ON "ApiIdempotencyRecord"("userId", "method", "path", "idemKey");

-- CreateIndex
CREATE INDEX "ApiIdempotencyRecord_expireAt_idx" ON "ApiIdempotencyRecord"("expireAt");

-- AddForeignKey
ALTER TABLE "GachaPlacementState" ADD CONSTRAINT "GachaPlacementState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "UserAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GachaPlacementSlot" ADD CONSTRAINT "GachaPlacementSlot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "UserAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GachaPlacementSlot" ADD CONSTRAINT "GachaPlacementSlot_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "GachaCardDefinition"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiIdempotencyRecord" ADD CONSTRAINT "ApiIdempotencyRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "UserAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

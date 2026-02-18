-- CreateEnum
CREATE TYPE "GachaBuyRequestStatus" AS ENUM ('OPEN', 'FULFILLED', 'CANCELLED', 'EXPIRED');

-- CreateTable
CREATE TABLE "GachaBuyRequest" (
    "id" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "targetCardId" TEXT NOT NULL,
    "tokenOffer" INTEGER NOT NULL DEFAULT 0,
    "status" "GachaBuyRequestStatus" NOT NULL DEFAULT 'OPEN',
    "fulfillerId" TEXT,
    "metadata" JSONB,
    "expiresAt" TIMESTAMP(3),
    "fulfilledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GachaBuyRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GachaBuyRequestOfferedCard" (
    "id" TEXT NOT NULL,
    "buyRequestId" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GachaBuyRequestOfferedCard_pkey" PRIMARY KEY ("id")
);

-- AlterTable: Add buyRequestId to GachaCardInstance
ALTER TABLE "GachaCardInstance" ADD COLUMN "buyRequestId" TEXT;

-- CreateIndex
CREATE INDEX "GachaBuyRequest_status_createdAt_idx" ON "GachaBuyRequest"("status", "createdAt");
CREATE INDEX "GachaBuyRequest_status_expiresAt_idx" ON "GachaBuyRequest"("status", "expiresAt");
CREATE INDEX "GachaBuyRequest_buyerId_status_idx" ON "GachaBuyRequest"("buyerId", "status");
CREATE INDEX "GachaBuyRequest_targetCardId_status_idx" ON "GachaBuyRequest"("targetCardId", "status");

CREATE INDEX "GachaBuyRequestOfferedCard_buyRequestId_idx" ON "GachaBuyRequestOfferedCard"("buyRequestId");
CREATE INDEX "GachaBuyRequestOfferedCard_cardId_idx" ON "GachaBuyRequestOfferedCard"("cardId");

CREATE INDEX "GachaCardInstance_buyRequestId_idx" ON "GachaCardInstance"("buyRequestId");

-- AddForeignKey
ALTER TABLE "GachaBuyRequest" ADD CONSTRAINT "GachaBuyRequest_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "UserAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GachaBuyRequest" ADD CONSTRAINT "GachaBuyRequest_fulfillerId_fkey" FOREIGN KEY ("fulfillerId") REFERENCES "UserAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GachaBuyRequest" ADD CONSTRAINT "GachaBuyRequest_targetCardId_fkey" FOREIGN KEY ("targetCardId") REFERENCES "GachaCardDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "GachaBuyRequestOfferedCard" ADD CONSTRAINT "GachaBuyRequestOfferedCard_buyRequestId_fkey" FOREIGN KEY ("buyRequestId") REFERENCES "GachaBuyRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GachaBuyRequestOfferedCard" ADD CONSTRAINT "GachaBuyRequestOfferedCard_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "GachaCardDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GachaCardInstance" ADD CONSTRAINT "GachaCardInstance_buyRequestId_fkey" FOREIGN KEY ("buyRequestId") REFERENCES "GachaBuyRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

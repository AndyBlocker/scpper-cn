DO $$
BEGIN
  CREATE TYPE "GachaTradeListingStatus" AS ENUM ('OPEN', 'SOLD', 'CANCELLED', 'EXPIRED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

CREATE TABLE IF NOT EXISTS "GachaTradeListing" (
  "id" TEXT NOT NULL,
  "sellerId" TEXT NOT NULL,
  "buyerId" TEXT,
  "cardId" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL DEFAULT 1,
  "remaining" INTEGER NOT NULL DEFAULT 1,
  "unitPrice" INTEGER NOT NULL,
  "totalPrice" INTEGER NOT NULL,
  "status" "GachaTradeListingStatus" NOT NULL DEFAULT 'OPEN',
  "expiresAt" TIMESTAMP(3),
  "soldAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GachaTradeListing_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "GachaTradeListing_status_createdAt_idx" ON "GachaTradeListing"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "GachaTradeListing_sellerId_status_idx" ON "GachaTradeListing"("sellerId", "status");
CREATE INDEX IF NOT EXISTS "GachaTradeListing_buyerId_status_idx" ON "GachaTradeListing"("buyerId", "status");
CREATE INDEX IF NOT EXISTS "GachaTradeListing_cardId_status_idx" ON "GachaTradeListing"("cardId", "status");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'GachaTradeListing_sellerId_fkey'
  ) THEN
    ALTER TABLE "GachaTradeListing"
      ADD CONSTRAINT "GachaTradeListing_sellerId_fkey"
      FOREIGN KEY ("sellerId") REFERENCES "UserAccount"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'GachaTradeListing_buyerId_fkey'
  ) THEN
    ALTER TABLE "GachaTradeListing"
      ADD CONSTRAINT "GachaTradeListing_buyerId_fkey"
      FOREIGN KEY ("buyerId") REFERENCES "UserAccount"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'GachaTradeListing_cardId_fkey'
  ) THEN
    ALTER TABLE "GachaTradeListing"
      ADD CONSTRAINT "GachaTradeListing_cardId_fkey"
      FOREIGN KEY ("cardId") REFERENCES "GachaCardDefinition"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END
$$;

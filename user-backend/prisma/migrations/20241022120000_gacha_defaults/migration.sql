CREATE EXTENSION IF NOT EXISTS "pgcrypto";

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'GachaRarity') THEN
    CREATE TYPE "GachaRarity" AS ENUM ('WHITE', 'GREEN', 'BLUE', 'PURPLE', 'GOLD');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'GachaMatchMode') THEN
    CREATE TYPE "GachaMatchMode" AS ENUM ('ANY', 'ALL');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "GachaWallet" (
  id TEXT NOT NULL DEFAULT gen_random_uuid(),
  "userId" TEXT NOT NULL,
  balance INTEGER NOT NULL DEFAULT 0,
  "totalEarned" INTEGER NOT NULL DEFAULT 0,
  "totalSpent" INTEGER NOT NULL DEFAULT 0,
  "lastDailyClaimAt" TIMESTAMP(3) WITHOUT TIME ZONE,
  "createdAt" TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT "GachaWallet_pkey" PRIMARY KEY (id),
  CONSTRAINT "GachaWallet_userId_key" UNIQUE ("userId"),
  CONSTRAINT "GachaWallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "UserAccount"(id) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "GachaPool" (
  id TEXT NOT NULL DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  "tokenCost" INTEGER NOT NULL DEFAULT 10,
  "tenDrawCost" INTEGER NOT NULL DEFAULT 100,
  "rewardPerDuplicate" INTEGER NOT NULL DEFAULT 5,
  "startsAt" TIMESTAMP(3) WITHOUT TIME ZONE,
  "endsAt" TIMESTAMP(3) WITHOUT TIME ZONE,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT "GachaPool_pkey" PRIMARY KEY (id),
  CONSTRAINT "GachaPool_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "UserAccount"(id) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS "GachaCardDefinition" (
  id TEXT NOT NULL DEFAULT gen_random_uuid(),
  "poolId" TEXT NOT NULL,
  title TEXT NOT NULL,
  rarity "GachaRarity" NOT NULL,
  tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  weight INTEGER NOT NULL DEFAULT 1,
  "rewardTokens" INTEGER NOT NULL DEFAULT 0,
  "wikidotId" INTEGER,
  "pageId" INTEGER,
  "imageUrl" TEXT,
  "createdAt" TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT "GachaCardDefinition_pkey" PRIMARY KEY (id),
  CONSTRAINT "GachaCardDefinition_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "GachaPool"(id) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "GachaGlobalBoost" (
  id TEXT NOT NULL DEFAULT gen_random_uuid(),
  "includeTags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "excludeTags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "matchMode" "GachaMatchMode" NOT NULL DEFAULT 'ANY',
  "weightMultiplier" DOUBLE PRECISION NOT NULL DEFAULT 1,
  "startsAt" TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL DEFAULT now(),
  "endsAt" TIMESTAMP(3) WITHOUT TIME ZONE,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT "GachaGlobalBoost_pkey" PRIMARY KEY (id),
  CONSTRAINT "GachaGlobalBoost_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "UserAccount"(id) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS "GachaDraw" (
  id TEXT NOT NULL DEFAULT gen_random_uuid(),
  "userId" TEXT NOT NULL,
  "poolId" TEXT NOT NULL,
  "drawCount" INTEGER NOT NULL,
  "tokensSpent" INTEGER NOT NULL,
  "tokensReward" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT "GachaDraw_pkey" PRIMARY KEY (id),
  CONSTRAINT "GachaDraw_userId_fkey" FOREIGN KEY ("userId") REFERENCES "UserAccount"(id) ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "GachaDraw_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "GachaPool"(id) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "GachaDrawItem" (
  id TEXT NOT NULL DEFAULT gen_random_uuid(),
  "drawId" TEXT NOT NULL,
  "cardId" TEXT NOT NULL,
  rarity "GachaRarity" NOT NULL,
  "rewardTokens" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT "GachaDrawItem_pkey" PRIMARY KEY (id),
  CONSTRAINT "GachaDrawItem_drawId_fkey" FOREIGN KEY ("drawId") REFERENCES "GachaDraw"(id) ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "GachaDrawItem_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "GachaCardDefinition"(id) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "GachaInventory" (
  id TEXT NOT NULL DEFAULT gen_random_uuid(),
  "userId" TEXT NOT NULL,
  "cardId" TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT "GachaInventory_pkey" PRIMARY KEY (id),
  CONSTRAINT "GachaInventory_user_card_unique" UNIQUE ("userId", "cardId"),
  CONSTRAINT "GachaInventory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "UserAccount"(id) ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "GachaInventory_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "GachaCardDefinition"(id) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "GachaDismantleLog" (
  id TEXT NOT NULL DEFAULT gen_random_uuid(),
  "userId" TEXT NOT NULL,
  "cardId" TEXT NOT NULL,
  count INTEGER NOT NULL,
  "tokensEarned" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT "GachaDismantleLog_pkey" PRIMARY KEY (id),
  CONSTRAINT "GachaDismantleLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "UserAccount"(id) ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "GachaDismantleLog_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "GachaCardDefinition"(id) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "GachaLedgerEntry" (
  id TEXT NOT NULL DEFAULT gen_random_uuid(),
  "walletId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,
  metadata JSONB,
  "createdAt" TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT "GachaLedgerEntry_pkey" PRIMARY KEY (id),
  CONSTRAINT "GachaLedgerEntry_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "GachaWallet"(id) ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "GachaLedgerEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "UserAccount"(id) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "GachaWallet_userId_idx" ON "GachaWallet" ("userId");
CREATE INDEX IF NOT EXISTS "GachaPool_active_time_idx" ON "GachaPool" ("isActive", "startsAt", "endsAt");
CREATE INDEX IF NOT EXISTS "GachaPool_createdById_idx" ON "GachaPool" ("createdById");
CREATE INDEX IF NOT EXISTS "GachaCardDefinition_poolId_idx" ON "GachaCardDefinition" ("poolId");
CREATE INDEX IF NOT EXISTS "GachaCardDefinition_rarity_idx" ON "GachaCardDefinition" (rarity);
CREATE INDEX IF NOT EXISTS "GachaGlobalBoost_active_idx" ON "GachaGlobalBoost" ("isActive", "startsAt", "endsAt");
CREATE INDEX IF NOT EXISTS "GachaGlobalBoost_createdById_idx" ON "GachaGlobalBoost" ("createdById");
CREATE INDEX IF NOT EXISTS "GachaDraw_user_created_idx" ON "GachaDraw" ("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "GachaDraw_pool_created_idx" ON "GachaDraw" ("poolId", "createdAt");
CREATE INDEX IF NOT EXISTS "GachaDrawItem_drawId_idx" ON "GachaDrawItem" ("drawId");
CREATE INDEX IF NOT EXISTS "GachaDrawItem_cardId_idx" ON "GachaDrawItem" ("cardId");
CREATE INDEX IF NOT EXISTS "GachaInventory_cardId_idx" ON "GachaInventory" ("cardId");
CREATE INDEX IF NOT EXISTS "GachaDismantleLog_user_created_idx" ON "GachaDismantleLog" ("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "GachaLedgerEntry_user_created_idx" ON "GachaLedgerEntry" ("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "GachaLedgerEntry_walletId_idx" ON "GachaLedgerEntry" ("walletId");

ALTER TABLE "GachaPool" ALTER COLUMN "tokenCost" SET DEFAULT 10;
ALTER TABLE "GachaPool" ALTER COLUMN "tenDrawCost" SET DEFAULT 100;
ALTER TABLE "GachaPool" ALTER COLUMN "rewardPerDuplicate" SET DEFAULT 5;

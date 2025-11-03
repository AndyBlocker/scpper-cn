CREATE TABLE IF NOT EXISTS "GachaRarityReward" (
  "rarity" "GachaRarity" PRIMARY KEY,
  "drawReward" INTEGER NOT NULL DEFAULT 0,
  "dismantleReward" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL DEFAULT now()
);

INSERT INTO "GachaRarityReward" ("rarity", "drawReward", "dismantleReward")
VALUES
  ('WHITE', 1, 2),
  ('GREEN', 10, 5),
  ('BLUE', 50, 10),
  ('PURPLE', 100, 50),
  ('GOLD', 200, 100)
ON CONFLICT ("rarity") DO UPDATE
SET
  "drawReward" = EXCLUDED."drawReward",
  "dismantleReward" = EXCLUDED."dismantleReward",
  "updatedAt" = now();

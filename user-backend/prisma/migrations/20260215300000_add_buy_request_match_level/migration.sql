-- CreateEnum
CREATE TYPE "GachaBuyRequestMatchLevel" AS ENUM ('PAGE', 'IMAGE_VARIANT', 'COATING');

-- AlterTable
ALTER TABLE "GachaBuyRequest" ADD COLUMN "matchLevel" "GachaBuyRequestMatchLevel" NOT NULL DEFAULT 'IMAGE_VARIANT';
ALTER TABLE "GachaBuyRequest" ADD COLUMN "requiredCoating" "GachaAffixVisualStyle";

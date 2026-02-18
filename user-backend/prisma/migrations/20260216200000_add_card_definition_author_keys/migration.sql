-- AlterTable
ALTER TABLE "GachaCardDefinition" ADD COLUMN "authorKeys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Create new enums for image ingestion pipeline
CREATE TYPE "PageVersionImageStatus" AS ENUM ('PENDING', 'QUEUED', 'FETCHING', 'RESOLVED', 'FAILED');
CREATE TYPE "ImageAssetStatus" AS ENUM ('PENDING', 'FETCHING', 'READY', 'FAILED');
CREATE TYPE "ImageIngestJobStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- Create table to store deduplicated image assets
CREATE TABLE "ImageAsset" (
  "id" SERIAL PRIMARY KEY,
  "hashSha256" TEXT,
  "perceptualHash" TEXT,
  "mimeType" TEXT,
  "width" INTEGER,
  "height" INTEGER,
  "bytes" INTEGER,
  "storagePath" TEXT,
  "canonicalUrl" TEXT,
  "sourceHosts" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "status" "ImageAssetStatus" NOT NULL DEFAULT 'PENDING',
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastFetchedAt" TIMESTAMP(3),
  "errorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "ImageAsset_hashSha256_key" ON "ImageAsset" ("hashSha256");

-- Create table to store extracted image references per PageVersion
CREATE TABLE "PageVersionImage" (
  "id" SERIAL PRIMARY KEY,
  "pageVersionId" INTEGER NOT NULL,
  "originUrl" TEXT NOT NULL,
  "normalizedUrl" TEXT NOT NULL,
  "displayUrl" TEXT,
  "status" "PageVersionImageStatus" NOT NULL DEFAULT 'PENDING',
  "imageAssetId" INTEGER,
  "extractedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastQueuedAt" TIMESTAMP(3),
  "lastFetchedAt" TIMESTAMP(3),
  "failureCount" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "metadata" JSONB,
  CONSTRAINT "PageVersionImage_pageVersionId_fkey"
    FOREIGN KEY ("pageVersionId") REFERENCES "PageVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PageVersionImage_imageAssetId_fkey"
    FOREIGN KEY ("imageAssetId") REFERENCES "ImageAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "PageVersionImage_pageVersionId_normalizedUrl_key"
  ON "PageVersionImage" ("pageVersionId", "normalizedUrl");
CREATE INDEX "PageVersionImage_status_idx" ON "PageVersionImage" ("status");
CREATE INDEX "PageVersionImage_imageAssetId_idx" ON "PageVersionImage" ("imageAssetId");

-- Create table representing ingestion tasks / queue
CREATE TABLE "ImageIngestJob" (
  "id" SERIAL PRIMARY KEY,
  "pageVersionImageId" INTEGER NOT NULL,
  "status" "ImageIngestJobStatus" NOT NULL DEFAULT 'PENDING',
  "priority" INTEGER NOT NULL DEFAULT 100,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" TIMESTAMP(3),
  "lockedBy" TEXT,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ImageIngestJob_pageVersionImageId_fkey"
    FOREIGN KEY ("pageVersionImageId") REFERENCES "PageVersionImage"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ImageIngestJob_pageVersionImageId_key" ON "ImageIngestJob" ("pageVersionImageId");
CREATE INDEX "ImageIngestJob_status_nextRunAt_idx" ON "ImageIngestJob" ("status", "nextRunAt");
CREATE INDEX "ImageIngestJob_lockedAt_idx" ON "ImageIngestJob" ("lockedAt");

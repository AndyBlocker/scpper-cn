-- CreateEnum
CREATE TYPE "PageMetricType" AS ENUM ('COMMENT_COUNT', 'RATING', 'REVISION_COUNT', 'SCORE');

-- CreateEnum
CREATE TYPE "PageMetricThresholdType" AS ENUM ('ANY_CHANGE', 'ABSOLUTE', 'PERCENT');

-- CreateTable
CREATE TABLE "PageMetricWatch" (
    "id" SERIAL PRIMARY KEY,
    "pageId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "metric" "PageMetricType" NOT NULL,
    "thresholdType" "PageMetricThresholdType" NOT NULL DEFAULT 'ANY_CHANGE',
    "thresholdValue" DOUBLE PRECISION,
    "lastObserved" DOUBLE PRECISION,
    "source" TEXT NOT NULL,
    "mutedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT "PageMetricWatch_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "Page"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PageMetricWatch_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PageMetricAlert" (
    "id" SERIAL PRIMARY KEY,
    "watchId" INTEGER NOT NULL,
    "pageId" INTEGER NOT NULL,
    "metric" "PageMetricType" NOT NULL,
    "prevValue" DOUBLE PRECISION,
    "newValue" DOUBLE PRECISION,
    "diffValue" DOUBLE PRECISION,
    "detectedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "acknowledgedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT "PageMetricAlert_watchId_fkey" FOREIGN KEY ("watchId") REFERENCES "PageMetricWatch"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PageMetricAlert_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "Page"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "uniq_watch_owner_metric_source" ON "PageMetricWatch" ("pageId", "userId", "metric", "source");
CREATE INDEX "idx_watch_user_metric" ON "PageMetricWatch" ("userId", "metric");
CREATE INDEX "idx_watch_page_metric" ON "PageMetricWatch" ("pageId", "metric");

CREATE INDEX "idx_alert_watch_detected_at" ON "PageMetricAlert" ("watchId", "detectedAt");
CREATE INDEX "idx_alert_page_metric" ON "PageMetricAlert" ("pageId", "metric");
CREATE INDEX "idx_alert_metric_detected_at" ON "PageMetricAlert" ("metric", "detectedAt");

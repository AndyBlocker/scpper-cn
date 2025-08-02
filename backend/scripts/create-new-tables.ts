#!/usr/bin/env npx tsx

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function createNewTables() {
  console.log('Creating new tables for improved incremental sync...');
  
  try {
    // Create PageMetaStaging table
    await prisma.$executeRaw`
      CREATE TABLE IF NOT EXISTS "PageMetaStaging" (
        url           TEXT PRIMARY KEY,
        "wikidotId"   INTEGER,
        title         TEXT,
        rating        INTEGER,
        "voteCount"   INTEGER,
        "revisionCount" INTEGER,
        tags          TEXT[],
        "isDeleted"   BOOLEAN NOT NULL DEFAULT FALSE,
        "estimatedCost" INTEGER,
        "lastSeenAt"  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `;
    
    // Create index on lastSeenAt
    await prisma.$executeRaw`
      CREATE INDEX IF NOT EXISTS "PageMetaStaging_lastSeenAt_idx" ON "PageMetaStaging"("lastSeenAt");
    `;
    
    // Create DirtyPage table
    await prisma.$executeRaw`
      CREATE TABLE IF NOT EXISTS "DirtyPage" (
        "pageId"      INTEGER PRIMARY KEY REFERENCES "Page"(id) ON DELETE CASCADE,
        "needPhaseB"  BOOLEAN NOT NULL,
        "needPhaseC"  BOOLEAN NOT NULL,
        reasons       TEXT[],
        "donePhaseB"  BOOLEAN NOT NULL DEFAULT FALSE,
        "donePhaseC"  BOOLEAN NOT NULL DEFAULT FALSE,
        "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt"   TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `;
    
    // Create indexes on DirtyPage
    await prisma.$executeRaw`
      CREATE INDEX IF NOT EXISTS "DirtyPage_needPhaseB_donePhaseB_idx" ON "DirtyPage"("needPhaseB", "donePhaseB");
    `;
    
    await prisma.$executeRaw`
      CREATE INDEX IF NOT EXISTS "DirtyPage_needPhaseC_donePhaseC_idx" ON "DirtyPage"("needPhaseC", "donePhaseC");
    `;
    
    console.log('✅ Successfully created new tables!');
    
  } catch (error) {
    console.error('❌ Failed to create tables:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

createNewTables();
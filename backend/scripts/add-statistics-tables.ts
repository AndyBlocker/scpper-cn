import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function addStatisticsTables() {
  try {
    console.log('Creating statistics tables...');
    
    // Create SiteStats table
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "SiteStats" (
        "id" SERIAL PRIMARY KEY,
        "date" DATE UNIQUE NOT NULL,
        "totalUsers" INTEGER DEFAULT 0 NOT NULL,
        "activeUsers" INTEGER DEFAULT 0 NOT NULL,
        "totalPages" INTEGER DEFAULT 0 NOT NULL,
        "totalVotes" INTEGER DEFAULT 0 NOT NULL,
        "newUsersToday" INTEGER DEFAULT 0 NOT NULL,
        "newPagesToday" INTEGER DEFAULT 0 NOT NULL,
        "newVotesToday" INTEGER DEFAULT 0 NOT NULL,
        "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
        "updatedAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
      );
    `);
    
    // Create indexes for SiteStats
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "SiteStats_date_idx" ON "SiteStats"("date");
    `);
    
    // Create SeriesStats table
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "SeriesStats" (
        "id" SERIAL PRIMARY KEY,
        "seriesNumber" INTEGER UNIQUE NOT NULL,
        "isOpen" BOOLEAN DEFAULT false NOT NULL,
        "totalSlots" INTEGER NOT NULL,
        "usedSlots" INTEGER DEFAULT 0 NOT NULL,
        "usagePercentage" DOUBLE PRECISION DEFAULT 0.0 NOT NULL,
        "milestonePageId" INTEGER,
        "lastUpdated" TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
        "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
      );
    `);
    
    // Create indexes for SeriesStats
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "SeriesStats_seriesNumber_idx" ON "SeriesStats"("seriesNumber");
    `);
    
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "SeriesStats_isOpen_idx" ON "SeriesStats"("isOpen");
    `);
    
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "SeriesStats_usagePercentage_idx" ON "SeriesStats"("usagePercentage");
    `);
    
    console.log('✅ Successfully created statistics tables and indexes');
    
  } catch (error) {
    console.error('❌ Failed to create tables:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

addStatisticsTables()
  .then(() => {
    console.log('🎉 Statistics tables creation completed!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('💥 Statistics tables creation failed:', error);
    process.exit(1);
  });
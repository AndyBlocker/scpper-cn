import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function addUserFirstActivityField() {
  try {
    console.log('Adding firstActivityAt field to User table...');
    
    // Add the firstActivityAt column
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "User" 
      ADD COLUMN IF NOT EXISTS "firstActivityAt" TIMESTAMP;
    `);
    
    // Add index
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "User_firstActivityAt_idx" 
      ON "User"("firstActivityAt");
    `);
    
    console.log('✅ Successfully added firstActivityAt field and index');
    
  } catch (error) {
    console.error('❌ Failed to add field:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

addUserFirstActivityField()
  .then(() => {
    console.log('🎉 Migration completed!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('💥 Migration failed:', error);
    process.exit(1);
  });
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function addUserActivityDetailsFields() {
  try {
    console.log('Adding firstActivityType and firstActivityDetails fields to User table...');
    
    // Add the firstActivityType column
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "User" 
      ADD COLUMN IF NOT EXISTS "firstActivityType" TEXT;
    `);
    
    // Add the firstActivityDetails column
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "User" 
      ADD COLUMN IF NOT EXISTS "firstActivityDetails" TEXT;
    `);
    
    // Add index on firstActivityType
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "User_firstActivityType_idx" 
      ON "User"("firstActivityType");
    `);
    
    console.log('✅ Successfully added firstActivityType and firstActivityDetails fields and index');
    
  } catch (error) {
    console.error('❌ Failed to add fields:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

addUserActivityDetailsFields()
  .then(() => {
    console.log('🎉 Migration completed!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('💥 Migration failed:', error);
    process.exit(1);
  });
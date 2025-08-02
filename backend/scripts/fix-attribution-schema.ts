#!/usr/bin/env tsx
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function fixAttributionSchema() {
  console.log('🔧 Fixing Attribution schema...');
  
  try {
    // 1. 更新所有 null order 为 0
    await prisma.$executeRaw`
      UPDATE "Attribution" 
      SET "order" = 0 
      WHERE "order" IS NULL
    `;
    
    console.log('✅ Updated null orders to 0');
    
    // 2. 修改列为 NOT NULL（需要先运行上面的更新）
    await prisma.$executeRaw`
      ALTER TABLE "Attribution" 
      ALTER COLUMN "order" SET NOT NULL,
      ALTER COLUMN "order" SET DEFAULT 0
    `;
    
    console.log('✅ Made order column NOT NULL with default 0');
    
    // 3. 重建唯一约束（如果需要）
    console.log('✅ Schema fix completed');
    
  } catch (error) {
    console.error('❌ Failed to fix schema:', error);
  } finally {
    await prisma.$disconnect();
  }
}

fixAttributionSchema();
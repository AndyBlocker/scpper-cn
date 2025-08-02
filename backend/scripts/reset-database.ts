#!/usr/bin/env tsx
/**
 * Database Reset Script
 * 
 * This script performs a complete database reset and ensures the database
 * is in a ready state with the latest schema applied.
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

console.log('🔄 Starting database reset...');

async function resetDatabase() {
  try {
    // Step 1: Reset migrations
    console.log('📋 Step 1: Resetting migrations...');
    await execAsync('npx prisma migrate reset --force');
    console.log('✅ Migrations reset completed');

    // Step 2: Push current schema to database
    console.log('📋 Step 2: Applying current schema...');
    await execAsync('npx prisma db push --accept-data-loss');
    console.log('✅ Schema applied to database');

    // Step 3: Generate Prisma client
    console.log('📋 Step 3: Generating Prisma client...');
    await execAsync('npx prisma generate');
    console.log('✅ Prisma client generated');

    // Step 4: Verify database connection
    console.log('📋 Step 4: Verifying database connection...');
    const { PrismaClient } = await import('@prisma/client');
    const prisma = new PrismaClient();
    
    try {
      await prisma.$connect();
      console.log('✅ Database connection verified');
      
      // Check if all tables exist
      const tables = await prisma.$queryRaw<Array<{tablename: string}>>`
        SELECT tablename FROM pg_tables WHERE schemaname = 'public'
      `;
      
      console.log(`📊 Found ${tables.length} tables:`, tables.map(t => t.tablename).sort().join(', '));
      
    } finally {
      await prisma.$disconnect();
    }

    console.log('🎉 Database reset completed successfully!');
    console.log('💡 Your database is now ready for use with the latest schema.');

  } catch (error) {
    console.error('❌ Database reset failed:', error);
    process.exit(1);
  }
}

resetDatabase();
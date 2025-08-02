#!/usr/bin/env npx tsx

import { repairAllCacheFiles } from './repair-jsonl.js';
import { PrismaClient } from '@prisma/client';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { robustJsonParse } from './fix-json-parser.js';

const prisma = new PrismaClient();

interface ImportStats {
  pages: number;
  versions: number;
  users: number;
  revisions: number;
  votes: number;
  errors: number;
}

const stats: ImportStats = {
  pages: 0,
  versions: 0,
  users: 0,
  revisions: 0,
  votes: 0,
  errors: 0
};

// Reuse the same import functions from robust-import.ts but with better error handling
async function safeReadJsonlFile(filePath: string): Promise<any[]> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    const data = [];
    
    console.log(`Reading ${lines.length} lines from ${filePath}...`);
    
    for (let i = 0; i < lines.length; i++) {
      const parsed = robustJsonParse(lines[i], i + 1);
      if (parsed !== null) {
        data.push(parsed);
      } else {
        stats.errors++;
        
        // For debugging, show some context around problematic lines
        if (stats.errors <= 10) {
          const start = Math.max(0, i - 2);
          const end = Math.min(lines.length, i + 3);
          console.warn(`Context around line ${i + 1}:`);
          for (let j = start; j < end; j++) {
            const marker = j === i ? '>>> ' : '    ';
            console.warn(`${marker}${j + 1}: ${lines[j].substring(0, 100)}...`);
          }
        }
      }
      
      // Show progress for large files
      if (i > 0 && i % 5000 === 0) {
        console.log(`  Progress: ${i}/${lines.length} (${((i/lines.length)*100).toFixed(1)}%)`);
      }
    }
    
    console.log(`Successfully parsed ${data.length}/${lines.length} lines from ${filePath}`);
    return data;
    
  } catch (error) {
    console.log(`File ${filePath} not found, skipping...`);
    return [];
  }
}

// Import functions (simplified versions from robust-import.ts)
function parseDirection(direction: any): number | null {
  const dirMap: Record<string, number> = {
    '1': 1, '-1': -1, '0': 0,
    'UP': 1, 'DOWN': -1, 'NOVOTE': 0
  };
  return dirMap[String(direction)] ?? null;
}

function safeParseInt(value: any): number | null {
  if (value === null || value === undefined) return null;
  const parsed = parseInt(String(value));
  return isNaN(parsed) ? null : parsed;
}

function extractUrlKey(url: string): string {
  const match = url.match(/\/([^\/]+)$/);
  return match ? match[1] : url;
}

async function upsertUser(userData: any): Promise<number | null> {
  if (!userData || !userData.wikidotId) return null;
  
  try {
    const wikidotId = safeParseInt(userData.wikidotId);
    if (!wikidotId) return null;
    
    const user = await prisma.user.upsert({
      where: { wikidotId },
      update: { displayName: userData.displayName },
      create: { wikidotId, displayName: userData.displayName },
    });
    
    return user.id;
  } catch (error) {
    return null;
  }
}

async function importPhase1(data: any[]) {
  console.log(`\n=== Importing ${data.length} Phase 1 records ===`);
  
  const batchSize = 100;
  
  for (let i = 0; i < data.length; i += batchSize) {
    const batch = data.slice(i, i + batchSize);
    
    await prisma.$transaction(
      async (tx) => {
        for (const item of batch) {
          if (!item.url) continue;
          
          try {
            const urlKey = extractUrlKey(item.url);
            const page = await tx.page.upsert({
              where: { url: item.url },
              update: { urlKey },
              create: { url: item.url, urlKey },
            });
            
            const existingVersion = await tx.pageVersion.findFirst({
              where: { pageId: page.id, validTo: null },
            });

            if (!existingVersion) {
              await tx.pageVersion.create({
                data: {
                  pageId: page.id,
                  wikidotId: safeParseInt(item.wikidotId),
                  title: item.title,
                  rating: safeParseInt(item.rating),
                  voteCount: safeParseInt(item.voteCount),
                  revisionCount: safeParseInt(item.revisionCount),
                  tags: Array.isArray(item.tags) ? item.tags : [],
                  validFrom: new Date(item.createdAt || Date.now()),
                  isDeleted: Boolean(item.isDeleted),
                },
              });
              stats.versions++;
            }
            
            stats.pages++;
          } catch (error) {
            stats.errors++;
          }
        }
      },
      { timeout: 60000 }
    );
    
    if (i % 1000 === 0) {
      console.log(`Progress: ${i}/${data.length} (${((i/data.length)*100).toFixed(1)}%)`);
    }
  }
}

async function importPhase2Limited(data: any[]) {
  console.log(`\n=== Importing ${data.length} Phase 2 records (limited) ===`);
  
  // Process only first 10,000 records to avoid timeout
  const limitedData = data.slice(0, 10000);
  console.log(`Processing first ${limitedData.length} records to avoid timeout...`);
  
  for (let i = 0; i < limitedData.length; i++) {
    const item = limitedData[i];
    if (!item.url) continue;
    
    try {
      const page = await prisma.page.findUnique({
        where: { url: item.url },
        include: { versions: { where: { validTo: null }, take: 1 } },
      });

      if (!page || page.versions.length === 0) continue;
      const currentVersion = page.versions[0];
      
      // Update content
      await prisma.pageVersion.update({
        where: { id: currentVersion.id },
        data: {
          textContent: item.textContent?.substring(0, 50000), // Limit content size
          source: item.source?.substring(0, 50000),
        },
      });
      
    } catch (error) {
      stats.errors++;
    }
    
    if (i % 100 === 0) {
      console.log(`Progress: ${i}/${limitedData.length} (${((i/limitedData.length)*100).toFixed(1)}%)`);
    }
  }
}

async function main() {
  const cacheDir = process.argv[2] || '.cache';
  const useFixed = process.argv.includes('--use-fixed');
  
  console.log('🔧 Starting import with JSON repair...');
  console.log(`Cache directory: ${cacheDir}`);
  console.log(`Use fixed files: ${useFixed}`);
  
  try {
    let fileSuffix = '';
    
    if (!useFixed) {
      console.log('\n📋 Step 1: Checking and repairing JSON files...');
      const repairResults = await repairAllCacheFiles(cacheDir);
      console.log('Repair results:', repairResults);
      fileSuffix = '-fixed';
    }
    
    console.log('\n📋 Step 2: Importing data...');
    
    // Import Phase 1
    const phase1Data = await safeReadJsonlFile(path.join(cacheDir, `phase1${fileSuffix}.jsonl`));
    if (phase1Data.length > 0) {
      await importPhase1(phase1Data);
    }
    
    // Import Phase 2 (limited)
    const phase2Data = await safeReadJsonlFile(path.join(cacheDir, `phase2${fileSuffix}.jsonl`));
    if (phase2Data.length > 0) {
      await importPhase2Limited(phase2Data);
    }
    
    // Get final statistics
    const finalStats = await prisma.$queryRaw`
      SELECT 
        (SELECT COUNT(*) FROM "Page") as pages,
        (SELECT COUNT(*) FROM "PageVersion") as versions,
        (SELECT COUNT(*) FROM "User") as users,
        (SELECT COUNT(*) FROM "Vote") as votes,
        (SELECT COUNT(*) FROM "Revision") as revisions
    `;
    
    console.log('\n✅ Import completed!');
    console.log('Database Statistics:', finalStats[0]);
    console.log('Import Statistics:', stats);
    
  } catch (error) {
    console.error('❌ Import failed:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
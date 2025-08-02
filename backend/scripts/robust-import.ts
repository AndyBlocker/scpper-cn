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

function parseDirection(direction: any): number | null {
  const dirMap: Record<string, number> = {
    '1': 1,
    '-1': -1,
    '0': 0,
    'UP': 1,
    'DOWN': -1,
    'NOVOTE': 0
  };
  
  const parsed = dirMap[String(direction)];
  return parsed !== undefined ? parsed : null;
}

function safeParseInt(value: any): number | null {
  if (value === null || value === undefined) return null;
  const parsed = parseInt(String(value));
  return isNaN(parsed) ? null : parsed;
}

async function readJsonlFile(filePath: string): Promise<any[]> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    const data = [];
    
    for (let i = 0; i < lines.length; i++) {
      const parsed = robustJsonParse(lines[i], i + 1);
      if (parsed !== null) {
        data.push(parsed);
      } else {
        stats.errors++;
      }
    }
    
    return data;
  } catch (error) {
    console.log(`File ${filePath} not found, skipping...`);
    return [];
  }
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
      create: {
        wikidotId,
        displayName: userData.displayName,
      },
    });
    
    return user.id;
  } catch (error) {
    console.warn(`Failed to upsert user ${userData.wikidotId}:`, error.message);
    return null;
  }
}

async function importPhase1(data: any[]) {
  console.log(`Importing ${data.length} Phase 1 records...`);
  
  const batchSize = 100;
  
  for (let i = 0; i < data.length; i += batchSize) {
    const batch = data.slice(i, i + batchSize);
    
    await prisma.$transaction(
      async (tx) => {
        for (const item of batch) {
          if (!item.url) continue;
          
          try {
            // Extract user from createdBy
            let createdByUserId = null;
            if (item.createdBy && item.createdBy.wikidotId) {
              createdByUserId = await upsertUser(item.createdBy);
              if (createdByUserId) stats.users++;
            }
            
            const urlKey = extractUrlKey(item.url);
            
            // Upsert page
            const page = await tx.page.upsert({
              where: { url: item.url },
              update: { urlKey },
              create: {
                url: item.url,
                urlKey,
              },
            });
            
            if (page) stats.pages++;
            
            // Create or update page version
            const existingVersion = await tx.pageVersion.findFirst({
              where: {
                pageId: page.id,
                validTo: null,
              },
            });

            const needNewVersion = !existingVersion || 
              existingVersion.wikidotId !== safeParseInt(item.wikidotId) ||
              existingVersion.title !== item.title;

            if (needNewVersion) {
              if (existingVersion) {
                await tx.pageVersion.update({
                  where: { id: existingVersion.id },
                  data: { validTo: new Date() },
                });
              }

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
            } else if (existingVersion) {
              await tx.pageVersion.update({
                where: { id: existingVersion.id },
                data: {
                  rating: safeParseInt(item.rating),
                  voteCount: safeParseInt(item.voteCount),
                  revisionCount: safeParseInt(item.revisionCount),
                  title: item.title,
                  tags: Array.isArray(item.tags) ? item.tags : [],
                },
              });
            }
            
          } catch (error) {
            console.warn(`Failed to import Phase 1 for ${item.url}:`, error.message);
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

async function importPhase2(data: any[]) {
  console.log(`Importing ${data.length} Phase 2 records...`);
  
  for (let i = 0; i < data.length; i++) {
    const item = data[i];
    if (!item.url) continue;
    
    try {
      await prisma.$transaction(
        async (tx) => {
          // Extract users from attributions (co-authors)
          const coAuthors: number[] = [];
          if (item.attributions && Array.isArray(item.attributions)) {
            for (const attribution of item.attributions) {
              let userId = null;
              if (attribution.user && attribution.user.wikidotUser) {
                userId = await upsertUser(attribution.user.wikidotUser);
              } else if (attribution.user && attribution.user.wikidotId) {
                userId = await upsertUser(attribution.user);
              }
              if (userId && !coAuthors.includes(userId)) {
                coAuthors.push(userId);
                stats.users++;
              }
            }
          }
          
          // Find page and current version
          const page = await tx.page.findUnique({
            where: { url: item.url },
            include: {
              versions: {
                where: { validTo: null },
                take: 1,
              },
            },
          });

          if (!page || page.versions.length === 0) return;
          const currentVersion = page.versions[0];
          
          // Update with Phase 2 content
          await tx.pageVersion.update({
            where: { id: currentVersion.id },
            data: {
              textContent: item.textContent,
              source: item.source,
            },
          });
          
          // Import votes from fuzzyVoteRecords
          if (item.fuzzyVoteRecords && item.fuzzyVoteRecords.edges) {
            for (const edge of item.fuzzyVoteRecords.edges) {
              const vote = edge.node;
              const direction = parseDirection(vote.direction);
              if (direction === null) continue;
              
              let userId = null;
              if (vote.user && vote.user.wikidotId) {
                userId = await upsertUser(vote.user);
              } else if (vote.userWikidotId) {
                userId = await upsertUser({ wikidotId: vote.userWikidotId, displayName: null });
              }
              
              try {
                await tx.vote.upsert({
                  where: {
                    Vote_unique_constraint: {
                      pageVersionId: currentVersion.id,
                      userId: userId,
                      timestamp: new Date(vote.timestamp),
                    },
                  },
                  update: { direction },
                  create: {
                    pageVersionId: currentVersion.id,
                    timestamp: new Date(vote.timestamp),
                    direction,
                    userId,
                  },
                });
                stats.votes++;
              } catch (error) {
                // Skip duplicate votes
              }
            }
          }
          
          // Import revisions  
          if (item.revisions && item.revisions.edges) {
            for (const edge of item.revisions.edges) {
              const revision = edge.node;
              
              let userId = null;
              if (revision.user && revision.user.wikidotId) {
                userId = await upsertUser(revision.user);
              }
              
              try {
                await tx.revision.upsert({
                  where: {
                    pageVersionId_wikidotId: {
                      pageVersionId: currentVersion.id,
                      wikidotId: safeParseInt(revision.wikidotId),
                    },
                  },
                  update: {},
                  create: {
                    pageVersionId: currentVersion.id,
                    wikidotId: safeParseInt(revision.wikidotId),
                    timestamp: new Date(revision.timestamp),
                    type: revision.type || 'unknown',
                    comment: revision.comment,
                    userId,
                  },
                });
                stats.revisions++;
              } catch (error) {
                // Skip duplicate revisions
              }
            }
          }
        },
        { timeout: 120000 }
      );
      
    } catch (error) {
      console.warn(`Failed to import Phase 2 for ${item.url}:`, error.message);
      stats.errors++;
    }
    
    if (i % 100 === 0) {
      console.log(`Progress: ${i}/${data.length} (${((i/data.length)*100).toFixed(1)}%)`);
    }
  }
}

async function importPhase3(data: any[]) {
  console.log(`Importing ${data.length} Phase 3 records...`);
  
  for (const item of data) {
    if (!item.url) continue;
    
    try {
      const page = await prisma.page.findUnique({
        where: { url: item.url },
        include: {
          versions: {
            where: { validTo: null },
            take: 1,
          },
        },
      });

      if (!page || page.versions.length === 0) continue;
      const currentVersion = page.versions[0];

      // Import additional revisions
      if (item.revisions && Array.isArray(item.revisions)) {
        for (const revision of item.revisions) {
          let userId = null;
          if (revision.user && revision.user.wikidotId) {
            userId = await upsertUser(revision.user);
          }
          
          try {
            await prisma.revision.upsert({
              where: {
                pageVersionId_wikidotId: {
                  pageVersionId: currentVersion.id,
                  wikidotId: safeParseInt(revision.wikidotId),
                },
              },
              update: {},
              create: {
                pageVersionId: currentVersion.id,
                wikidotId: safeParseInt(revision.wikidotId),
                timestamp: new Date(revision.timestamp),
                type: revision.type || 'unknown',
                comment: revision.comment,
                userId,
              },
            });
            stats.revisions++;
          } catch (error) {
            // Skip duplicates
          }
        }
      }
      
    } catch (error) {
      console.warn(`Failed to import Phase 3 for ${item.url}:`, error.message);
      stats.errors++;
    }
  }
}

async function main() {
  const cacheDir = process.argv[2] || '.cache';
  
  console.log('Starting robust import with improved error handling...');
  console.log(`Cache directory: ${cacheDir}`);
  
  try {
    // Phase 1: Basic page info + users from createdBy
    const phase1Data = await readJsonlFile(path.join(cacheDir, 'phase1.jsonl'));
    if (phase1Data.length > 0) {
      await importPhase1(phase1Data);
    }
    
    // Phase 2: Content + votes + revisions + co-authors
    const phase2Data = await readJsonlFile(path.join(cacheDir, 'phase2.jsonl'));
    if (phase2Data.length > 0) {
      await importPhase2(phase2Data);
    }
    
    // Phase 3: Additional revisions
    const phase3Data = await readJsonlFile(path.join(cacheDir, 'phase3.jsonl'));
    if (phase3Data.length > 0) {
      await importPhase3(phase3Data);
    }
    
    // Final statistics
    const finalStats = await prisma.$queryRaw`
      SELECT 
        (SELECT COUNT(*) FROM "Page") as pages,
        (SELECT COUNT(*) FROM "PageVersion") as versions,
        (SELECT COUNT(*) FROM "User") as users,
        (SELECT COUNT(*) FROM "Vote") as votes,
        (SELECT COUNT(*) FROM "Revision") as revisions
    `;
    
    console.log('\n=== Import Completed Successfully! ===');
    console.log('Database Statistics:', finalStats[0]);
    console.log('Import Statistics:', stats);
    
  } catch (error) {
    console.error('Import failed:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
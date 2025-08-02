#!/usr/bin/env tsx
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function quickCheck() {
  console.log('🔍 Quick Database Check\n');
  
  try {
    // Table counts
    const counts = await Promise.all([
      prisma.page.count(),
      prisma.pageVersion.count(),
      prisma.revision.count(),
      prisma.vote.count(),
      prisma.user.count(),
      prisma.attribution.count(),
      prisma.dirtyPage.count()
    ]);

    console.log('📊 Table Counts:');
    console.log(`Pages: ${counts[0]}`);
    console.log(`Page Versions: ${counts[1]}`);
    console.log(`Revisions: ${counts[2]}`);
    console.log(`Votes: ${counts[3]}`);
    console.log(`Users: ${counts[4]}`);
    console.log(`Attributions: ${counts[5]}`);
    console.log(`Dirty Pages: ${counts[6]}\n`);

    // Vote constraint verification
    console.log('🗳️ Vote Constraint Check:');
    const duplicateVotes = await prisma.$queryRaw<Array<{count: number, pageVersionId: number, userId: number, timestamp: Date}>>`
      SELECT COUNT(*) as count, "pageVersionId", "userId", timestamp
      FROM "Vote" 
      WHERE "userId" IS NOT NULL
      GROUP BY "pageVersionId", "userId", timestamp
      HAVING COUNT(*) > 1
    `;
    
    const duplicateAnonVotes = await prisma.$queryRaw<Array<{count: number, pageVersionId: number, anonKey: string, timestamp: Date}>>`
      SELECT COUNT(*) as count, "pageVersionId", "anonKey", timestamp
      FROM "Vote" 
      WHERE "anonKey" IS NOT NULL
      GROUP BY "pageVersionId", "anonKey", timestamp
      HAVING COUNT(*) > 1
    `;

    console.log(`Duplicate authenticated votes: ${duplicateVotes.length}`);
    console.log(`Duplicate anonymous votes: ${duplicateAnonVotes.length}`);

    // Sample data verification
    console.log('\n📋 Sample Data:');
    const samplePage = await prisma.page.findFirst({
      include: {
        versions: {
          include: {
            votes: { take: 3, include: { user: true } },
            revisions: { take: 3, include: { user: true } },
            attributions: { include: { user: true } }
          }
        }
      }
    });

    if (samplePage) {
      console.log(`\nSample Page: ${samplePage.url}`);
      const version = samplePage.versions[0];
      if (version) {
        console.log(`- Title: ${version.title || 'N/A'}`);
        console.log(`- Rating: ${version.rating || 'N/A'}`);
        console.log(`- Vote Count: ${version.voteCount || 0}`);
        console.log(`- Revision Count: ${version.revisionCount || 0}`);
        console.log(`- Has Text Content: ${!!version.textContent}`);
        console.log(`- Has Source: ${!!version.source}`);
        console.log(`- Votes in DB: ${version.votes.length}`);
        console.log(`- Revisions in DB: ${version.revisions.length}`);
        console.log(`- Attributions: ${version.attributions.length}`);
        
        if (version.votes.length > 0) {
          const vote = version.votes[0];
          console.log(`- Sample Vote: direction=${vote.direction}, user=${vote.user?.displayName || 'Anonymous'}, anonKey=${vote.anonKey || 'N/A'}`);
        }
      }
    }

    // Dirty pages status
    console.log('\n🔄 Dirty Pages Status:');
    const dirtyStats = await prisma.dirtyPage.groupBy({
      by: ['needPhaseB', 'needPhaseC', 'donePhaseB', 'donePhaseC'],
      _count: true
    });
    
    dirtyStats.forEach(stat => {
      console.log(`B:${stat.needPhaseB}/${stat.donePhaseB} C:${stat.needPhaseC}/${stat.donePhaseC} - Count: ${stat._count}`);
    });

  } catch (error) {
    console.error('❌ Check failed:', error);
  } finally {
    await prisma.$disconnect();
  }
}

quickCheck().catch(console.error);
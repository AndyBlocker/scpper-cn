import { getPrismaClient, disconnectPrisma } from '../src/utils/db-connection.js';

async function checkSyncProgress() {
  const prisma = getPrismaClient();
  
  try {
    console.log('=== Sync Progress Report ===\n');
    
    // Check total pages
    const totalPages = await prisma.page.count();
    const deletedPages = await prisma.page.count({ where: { isDeleted: true } });
    console.log(`Total pages: ${totalPages} (${deletedPages} deleted)`);
    
    // Check page versions
    const totalVersions = await prisma.pageVersion.count();
    const versionsWithContent = await prisma.pageVersion.count({
      where: { textContent: { not: null } }
    });
    console.log(`Total page versions: ${totalVersions} (${versionsWithContent} with content)`);
    
    // Check dirty queue status
    const dirtyPageStats = {
      total: await prisma.dirtyPage.count(),
      needPhaseB: await prisma.dirtyPage.count({ where: { needPhaseB: true, donePhaseB: false } }),
      needPhaseC: await prisma.dirtyPage.count({ where: { needPhaseC: true, donePhaseC: false } }),
      completedB: await prisma.dirtyPage.count({ where: { needPhaseB: true, donePhaseB: true } }),
      completedC: await prisma.dirtyPage.count({ where: { needPhaseC: true, donePhaseC: true } })
    };
    
    console.log(`\nDirty Queue Status:`);
    console.log(`  Total dirty pages: ${dirtyPageStats.total}`);
    console.log(`  Need Phase B: ${dirtyPageStats.needPhaseB} (completed: ${dirtyPageStats.completedB})`);
    console.log(`  Need Phase C: ${dirtyPageStats.needPhaseC} (completed: ${dirtyPageStats.completedC})`);
    
    // Check votes and revisions
    const totalVotes = await prisma.vote.count();
    const totalRevisions = await prisma.revision.count();
    console.log(`\nVotes and Revisions:`);
    console.log(`  Total votes: ${totalVotes}`);
    console.log(`  Total revisions: ${totalRevisions}`);
    
    // Check users
    const totalUsers = await prisma.user.count();
    console.log(`\nTotal users: ${totalUsers}`);
    
    // Check recent errors in pageVersion 126020
    const pageVersion126020 = await prisma.pageVersion.findUnique({
      where: { id: 126020 },
      include: {
        page: true,
        votes: { take: 10 },
        revisions: { take: 10 }
      }
    });
    
    if (pageVersion126020) {
      console.log(`\nPageVersion 126020 details:`);
      console.log(`  Page URL: ${pageVersion126020.page?.currentUrl}`);
      console.log(`  WikidotId: ${pageVersion126020.wikidotId}`);
      console.log(`  Votes count: ${await prisma.vote.count({ where: { pageVersionId: 126020 } })}`);
      console.log(`  Revisions count: ${await prisma.revision.count({ where: { pageVersionId: 126020 } })}`);
    }
    
    // Check connection pool status
    interface PoolStatus {
      connections: bigint;
      state: string | null;
      query: string | null;
    }
    
    const poolStatus = await prisma.$queryRaw<PoolStatus[]>`
      SELECT count(*) as connections, 
             state,
             query
      FROM pg_stat_activity
      WHERE datname = current_database()
      GROUP BY state, query
      ORDER BY count(*) DESC
      LIMIT 10;
    `;
    
    console.log(`\nDatabase Connection Pool Status:`);
    console.log(poolStatus.map(row => ({
      connections: Number(row.connections),
      state: row.state || 'unknown',
      query: row.query ? row.query.substring(0, 100) + '...' : 'N/A'
    })));
    
    // Check specific sync phase progress
    console.log('\n=== Phase Progress Details ===');
    
    // Phase A completion check
    const pageMetaStagingCount = await prisma.pageMetaStaging.count();
    console.log(`\nPhase A Status:`);
    console.log(`  Pages in staging: ${pageMetaStagingCount}`);
    
    // Find pages that failed in Phase C
    const failedPhaseC = await prisma.dirtyPage.findMany({
      where: {
        needPhaseC: true,
        donePhaseC: false,
        wikidotId: { not: null }
      },
      take: 5,
      include: {
        page: {
          select: {
            currentUrl: true,
            wikidotId: true
          }
        }
      }
    });
    
    console.log(`\nSample of pages pending Phase C:`);
    failedPhaseC.forEach(dp => {
      console.log(`  - WikidotId: ${dp.wikidotId}, URL: ${dp.page?.currentUrl || dp.stagingUrl || 'N/A'}`);
      console.log(`    Reasons: ${dp.reasons.join(', ')}`);
    });
    
    // Check if there are orphaned records
    const orphanedDirtyPages = await prisma.dirtyPage.count({
      where: {
        pageId: null,
        wikidotId: null
      }
    });
    console.log(`\nOrphaned dirty pages (no pageId or wikidotId): ${orphanedDirtyPages}`);
    
  } catch (error) {
    console.error('Error checking sync progress:', error);
  } finally {
    await disconnectPrisma();
  }
}

checkSyncProgress();
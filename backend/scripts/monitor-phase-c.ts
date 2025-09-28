import { getPrismaClient, disconnectPrisma } from '../src/utils/db-connection.js';

async function monitorPhaseC() {
  const prisma = getPrismaClient();
  
  try {
    // Get Phase C progress
    const phaseCStats = {
      total: await prisma.dirtyPage.count({ where: { needPhaseC: true } }),
      pending: await prisma.dirtyPage.count({ where: { needPhaseC: true, donePhaseC: false } }),
      completed: await prisma.dirtyPage.count({ where: { needPhaseC: true, donePhaseC: true } })
    };
    
    const progressPercent = phaseCStats.total > 0 
      ? ((phaseCStats.completed / phaseCStats.total) * 100).toFixed(2)
      : '0.00';
    
    console.log('=== Phase C Progress ===');
    console.log(`Total pages needing Phase C: ${phaseCStats.total}`);
    console.log(`Completed: ${phaseCStats.completed} (${progressPercent}%)`);
    console.log(`Remaining: ${phaseCStats.pending}`);
    
    // Get recent activity
    const recentCompleted = await prisma.dirtyPage.findMany({
      where: {
        needPhaseC: true,
        donePhaseC: true
      },
      orderBy: { updatedAt: 'desc' },
      take: 5,
      include: {
        page: {
          select: {
            currentUrl: true
          }
        }
      }
    });
    
    if (recentCompleted.length > 0) {
      console.log('\nRecently completed pages:');
      recentCompleted.forEach(dp => {
        const timeSince = new Date().getTime() - new Date(dp.updatedAt).getTime();
        const minutes = Math.floor(timeSince / 60000);
        console.log(`  - ${dp.page?.currentUrl || 'Unknown'} (${minutes} minutes ago)`);
      });
    }
    
    // Check connection status
    const connStatus = await prisma.$queryRaw<Array<{total: bigint, idle: bigint, active: bigint}>>`
      SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE state = 'idle') as idle,
        COUNT(*) FILTER (WHERE state = 'active') as active
      FROM pg_stat_activity
      WHERE datname = current_database();
    `;
    
    console.log('\nConnection Status:');
    console.log(`  Total: ${connStatus[0]?.total || 0}`);
    console.log(`  Active: ${connStatus[0]?.active || 0}`);
    console.log(`  Idle: ${connStatus[0]?.idle || 0}`);
    
    // Estimate completion time
    if (phaseCStats.completed > 0 && phaseCStats.pending > 0) {
      // Get the time of the first completed page
      const firstCompleted = await prisma.dirtyPage.findFirst({
        where: {
          needPhaseC: true,
          donePhaseC: true
        },
        orderBy: { updatedAt: 'asc' }
      });
      
      if (firstCompleted) {
        const elapsedMs = new Date().getTime() - new Date(firstCompleted.updatedAt).getTime();
        const avgTimePerPage = elapsedMs / phaseCStats.completed;
        const remainingMs = avgTimePerPage * phaseCStats.pending;
        const remainingMinutes = Math.ceil(remainingMs / 60000);
        
        console.log(`\nEstimated time remaining: ${remainingMinutes} minutes`);
        console.log(`Average processing speed: ${(phaseCStats.completed / (elapsedMs / 60000)).toFixed(1)} pages/minute`);
      }
    }
    
  } catch (error) {
    console.error('Error monitoring Phase C:', error);
  } finally {
    await disconnectPrisma();
  }
}

monitorPhaseC();
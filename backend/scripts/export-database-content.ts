#!/usr/bin/env tsx
import { PrismaClient } from '@prisma/client';
import { writeFileSync } from 'fs';

const prisma = new PrismaClient();

async function exportDatabaseContent() {
  console.log('📊 Exporting database content...');
  
  const exportData: any = {
    exportedAt: new Date().toISOString(),
    summary: {},
    data: {}
  };

  try {
    // Get all tables with counts
    console.log('📋 Getting table counts...');
    
    const [
      pages,
      pageVersions,
      revisions,
      votes,
      users,
      attributions,
      pageStats,
      userStats,
      pageMetaStaging,
      dirtyPages
    ] = await Promise.all([
      prisma.page.count(),
      prisma.pageVersion.count(),
      prisma.revision.count(),
      prisma.vote.count(),
      prisma.user.count(),
      prisma.attribution.count(),
      prisma.pageStats.count(),
      prisma.userStats.count(),
      prisma.pageMetaStaging.count(),
      prisma.dirtyPage.count(),
    ]);

    exportData.summary = {
      pages,
      pageVersions,
      revisions,
      votes,
      users,
      attributions,
      pageStats,
      userStats,
      pageMetaStaging,
      dirtyPages
    };

    console.log('📊 Summary:', exportData.summary);

    // Export all Pages with their relationships
    console.log('📄 Exporting Pages...');
    exportData.data.pages = await prisma.page.findMany({
      include: {
        versions: {
          include: {
            revisions: {
              take: 5,
              orderBy: { timestamp: 'desc' },
              include: {
                user: true
              }
            },
            votes: {
              take: 5,
              orderBy: { timestamp: 'desc' },
              include: {
                user: true
              }
            },
            attributions: {
              include: {
                user: true
              }
            },
            stats: true
          }
        },
        dirtyPage: true
      }
    });

    // Export all Users with their stats
    console.log('👥 Exporting Users...');
    exportData.data.users = await prisma.user.findMany({
      include: {
        stats: true,
        votes: {
          take: 5,
          orderBy: { timestamp: 'desc' }
        },
        revisions: {
          take: 5,
          orderBy: { timestamp: 'desc' }
        },
        attributions: {
          take: 5
        }
      }
    });

    // Export PageMetaStaging
    console.log('📋 Exporting PageMetaStaging...');
    exportData.data.pageMetaStaging = await prisma.pageMetaStaging.findMany({
      orderBy: { lastSeenAt: 'desc' }
    });

    // Export DirtyPages
    console.log('🔄 Exporting DirtyPages...');
    exportData.data.dirtyPages = await prisma.dirtyPage.findMany({
      include: {
        page: true
      },
      orderBy: { createdAt: 'desc' }
    });

    // Additional analysis
    console.log('📊 Generating analysis...');
    
    // Vote analysis
    const voteAnalysis = await prisma.vote.groupBy({
      by: ['direction'],
      _count: {
        direction: true
      }
    });

    // User analysis with vote counts
    const topVoters = await prisma.user.findMany({
      include: {
        _count: {
          select: {
            votes: true,
            revisions: true,
            attributions: true
          }
        }
      },
      orderBy: {
        votes: {
          _count: 'desc'
        }
      },
      take: 10
    });

    // Pages with most votes
    const topVotedPages = await prisma.pageVersion.findMany({
      include: {
        page: true,
        _count: {
          select: {
            votes: true,
            revisions: true
          }
        }
      },
      orderBy: {
        votes: {
          _count: 'desc'
        }
      },
      take: 10
    });

    exportData.analysis = {
      voteDistribution: voteAnalysis,
      topVoters: topVoters,
      topVotedPages: topVotedPages,
      anonymousVotes: await prisma.vote.count({
        where: { userId: null }
      }),
      authenticatedVotes: await prisma.vote.count({
        where: { userId: { not: null } }
      })
    };

    // Sample data for verification
    console.log('🔍 Getting sample data...');
    const samplePage = await prisma.page.findFirst({
      include: {
        versions: {
          include: {
            revisions: {
              take: 3,
              include: { user: true }
            },
            votes: {
              take: 3,
              include: { user: true }
            },
            attributions: {
              include: { user: true }
            }
          }
        }
      }
    });

    exportData.samples = {
      page: samplePage
    };

    // Write to file
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `database-export-${timestamp}.json`;
    const filepath = `/home/andyblocker/scpper-cn/backend/${filename}`;
    
    writeFileSync(filepath, JSON.stringify(exportData, null, 2));
    
    console.log(`✅ Database content exported to: ${filepath}`);
    console.log(`📊 File size: ${(JSON.stringify(exportData).length / 1024 / 1024).toFixed(2)} MB`);
    
    // Print summary
    console.log('\n📋 Export Summary:');
    console.log('==================');
    Object.entries(exportData.summary).forEach(([table, count]) => {
      console.log(`${table.padEnd(20)}: ${count}`);
    });
    
    console.log('\n🔍 Analysis Summary:');
    console.log('==================');
    console.log(`Anonymous votes     : ${exportData.analysis.anonymousVotes}`);
    console.log(`Authenticated votes : ${exportData.analysis.authenticatedVotes}`);
    console.log(`Vote distribution   :`, exportData.analysis.voteDistribution);
    
    if (exportData.analysis.topVoters.length > 0) {
      console.log(`\nTop voter: ${exportData.analysis.topVoters[0].displayName || 'Unknown'} (${exportData.analysis.topVoters[0]._count.votes} votes)`);
    }
    
    if (exportData.analysis.topVotedPages.length > 0) {
      console.log(`Most voted page: ${exportData.analysis.topVotedPages[0].page.url} (${exportData.analysis.topVotedPages[0]._count.votes} votes)`);
    }

  } catch (error) {
    console.error('❌ Export failed:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// Run the export
exportDatabaseContent().catch(console.error);
import { PrismaClient } from '@prisma/client';
import { table } from 'table';

export async function query({ 
  url, 
  user, 
  stats, 
  userRank, 
  category 
}: { 
  url?: string; 
  user?: string; 
  stats?: boolean; 
  userRank?: boolean;
  category?: string;
}) {
  const prisma = new PrismaClient();

  try {
    if (url) {
      const page = await prisma.page.findUnique({
        where: { url },
        include: {
          versions: {
            include: { stats: true },
            orderBy: { validFrom: 'desc' }
          }
        }
      });

      if (!page) {
        console.log('Page not found');
        return;
      }

      console.log(table([
        ['Version ID', 'Valid Period', 'Rating', 'RCnt', 'VCnt', 'Wilson', 'Controversy', 'Deleted'],
        ...page.versions.map(v => [
          v.id.toString(),
          `${v.validFrom.toISOString()} ⇢ ${v.validTo ? v.validTo.toISOString() : 'now'}`,
          v.rating?.toString() || '—',
          v.revisionCount?.toString() || '—',
          v.voteCount?.toString() || '—',
          v.stats?.wilson95?.toFixed(3) || '—',
          v.stats?.controversy?.toFixed(3) || '—',
          v.isDeleted.toString()
        ])
      ]));
    }

    if (user) {
      // Try to find user by displayName first, then by wikidotId if it's a number
      const isNumeric = /^\d+$/.test(user);
      const userData = await prisma.user.findFirst({
        where: isNumeric 
          ? { wikidotId: parseInt(user) }
          : { displayName: user },
        include: {
          stats: true,
          votes: { take: 10, orderBy: { timestamp: 'desc' } },
          revisions: { take: 5, orderBy: { timestamp: 'desc' } },
          attributions: { 
            take: 10, 
            include: { 
              pageVersion: { 
                include: { page: true } 
              } 
            } 
          }
        }
      });

      if (!userData) {
        console.log('User not found');
        return;
      }

      console.log(`\nUser: ${userData.displayName}`);
      console.log(`Wikidot ID: ${userData.wikidotId || 'Unknown'}`);
      
      if (userData.stats) {
        console.log(`Total Up Votes: ${userData.stats.totalUp}`);
        console.log(`Total Down Votes: ${userData.stats.totalDown}`);
        console.log(`Total Rating: ${userData.stats.totalRating}`);
        console.log(`Favorite Tag: ${userData.stats.favTag || 'None'}`);
        
        // User Ranking Information
        console.log('\n=== User Rankings ===');
        console.log(table([
          ['Category', 'Rating', 'Rank', 'Page Count'],
          [
            'Overall',
            userData.stats.overallRating?.toString() || '—',
            userData.stats.overallRank?.toString() || '—',
            userData.stats.pageCount.toString()
          ],
          [
            'SCP',
            userData.stats.scpRating?.toString() || '—',
            userData.stats.scpRank?.toString() || '—',
            userData.stats.scpPageCount.toString()
          ],
          [
            'Translation',
            userData.stats.translationRating?.toString() || '—',
            userData.stats.translationRank?.toString() || '—',
            userData.stats.translationPageCount.toString()
          ],
          [
            'GOI Format',
            userData.stats.goiRating?.toString() || '—',
            userData.stats.goiRank?.toString() || '—',
            userData.stats.goiPageCount.toString()
          ],
          [
            'Story',
            userData.stats.storyRating?.toString() || '—',
            userData.stats.storyRank?.toString() || '—',
            userData.stats.storyPageCount.toString()
          ]
        ]));
        
        if (userData.stats.ratingUpdatedAt) {
          console.log(`Ratings last updated: ${userData.stats.ratingUpdatedAt.toISOString()}`);
        }
      }

      if (userData.votes.length > 0) {
        console.log('\nRecent Votes:');
        console.log(table([
          ['Date', 'Direction', 'Page Version ID'],
          ...userData.votes.map(v => [
            v.timestamp.toISOString().split('T')[0],
            v.direction > 0 ? '+1' : '-1',
            v.pageVersionId.toString()
          ])
        ]));
      }

      if (userData.attributions.length > 0) {
        console.log('\nRecent Attributions:');
        console.log(table([
          ['Type', 'Page Title', 'URL', 'Date'],
          ...userData.attributions.map(attr => [
            attr.type || 'Unknown',
            attr.pageVersion.title || 'Untitled',
            attr.pageVersion.page.url.split('/').pop() || 'Unknown',
            attr.date?.toISOString().split('T')[0] || '—'
          ])
        ]));
      }
    }

    if (stats) {
      const pageCount = await prisma.page.count();
      const versionCount = await prisma.pageVersion.count();
      const userCount = await prisma.user.count();
      const voteCount = await prisma.vote.count();
      const revisionCount = await prisma.revision.count();

      const topRated = await prisma.pageVersion.findMany({
        where: { validTo: null, rating: { not: null } },
        include: { page: true, stats: true },
        orderBy: { rating: 'desc' },
        take: 10
      });

      const topWilson = await prisma.pageVersion.findMany({
        where: { 
          validTo: null, 
          stats: { 
            isNot: null
          } 
        },
        include: { page: true, stats: true },
        orderBy: { stats: { wilson95: 'desc' } },
        take: 10
      });

      console.log('=== Database Statistics ===');
      console.log(`Pages: ${pageCount}`);
      console.log(`Page Versions: ${versionCount}`);
      console.log(`Users: ${userCount}`);
      console.log(`Votes: ${voteCount}`);
      console.log(`Revisions: ${revisionCount}`);

      console.log('\n=== Top Rated Pages ===');
      console.log(table([
        ['Title', 'Rating', 'Wilson Score', 'URL'],
        ...topRated.map(v => [
          v.title || 'Untitled',
          v.rating?.toString() || '0',
          v.stats?.wilson95?.toFixed(3) || '—',
          v.page.urlKey
        ])
      ]));

      console.log('\n=== Top Wilson Score Pages ===');
      console.log(table([
        ['Title', 'Rating', 'Wilson Score', 'URL'],
        ...topWilson.map(v => [
          v.title || 'Untitled',
          v.rating?.toString() || '0',
          v.stats?.wilson95?.toFixed(3) || '—',
          v.page.urlKey
        ])
      ]));
    }

    if (userRank) {
      const validCategories = ['overall', 'scp', 'translation', 'goi', 'story'];
      const selectedCategory = category && validCategories.includes(category) ? category : 'overall';
      
      console.log(`\n=== ${selectedCategory.toUpperCase()} User Rankings ===`);
      
      let orderBy: any;
      let ratingField: string;
      let rankField: string;
      let pageCountField: string;
      
      switch (selectedCategory) {
        case 'scp':
          orderBy = { scpRank: 'asc' };
          ratingField = 'scpRating';
          rankField = 'scpRank';
          pageCountField = 'scpPageCount';
          break;
        case 'translation':
          orderBy = { translationRank: 'asc' };
          ratingField = 'translationRating';
          rankField = 'translationRank';
          pageCountField = 'translationPageCount';
          break;
        case 'goi':
          orderBy = { goiRank: 'asc' };
          ratingField = 'goiRating';
          rankField = 'goiRank';
          pageCountField = 'goiPageCount';
          break;
        case 'story':
          orderBy = { storyRank: 'asc' };
          ratingField = 'storyRating';
          rankField = 'storyRank';
          pageCountField = 'storyPageCount';
          break;
        default:
          orderBy = { overallRank: 'asc' };
          ratingField = 'overallRating';
          rankField = 'overallRank';
          pageCountField = 'pageCount';
      }

      const topUsers = await prisma.userStats.findMany({
        where: {
          [rankField]: { not: null },
          [pageCountField]: { gt: 0 }
        },
        include: {
          user: true
        },
        orderBy,
        take: 50
      });

      if (topUsers.length === 0) {
        console.log('No ranking data available. Run user rating calculation first.');
        return;
      }

      console.log(table([
        ['Rank', 'User', 'Rating', 'Pages', 'Updated'],
        ...topUsers.map(userStat => [
          (userStat as any)[rankField]?.toString() || '—',
          userStat.user.displayName || 'Unknown',
          (userStat as any)[ratingField]?.toString() || '—',
          (userStat as any)[pageCountField]?.toString() || '0',
          userStat.ratingUpdatedAt?.toISOString().split('T')[0] || '—'
        ])
      ]));
      
      console.log(`\nShowing top 50 users in ${selectedCategory} category`);
      console.log(`Available categories: ${validCategories.join(', ')}`);
    }
  } catch (error) {
    console.error('Query failed:', error);
  } finally {
    await prisma.$disconnect();
  }
}
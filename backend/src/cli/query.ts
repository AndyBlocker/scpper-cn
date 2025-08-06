import { PrismaClient } from '@prisma/client';
import { table } from 'table';
import { UserRatingSystem } from '../jobs/UserRatingJob.js';
import { DatabaseStore } from '../core/store/DatabaseStore.js';

/**
 * 判断一个数字是否值得关注（特殊编号）
 */
function isNotableNumber(num: number): { notable: boolean; reason?: string } {
  // 整百数字 (x00, x000)
  if (num % 100 === 0) {
    return { notable: true, reason: '整百' };
  }
  
  // 大量重复数字
  const str = num.toString();
  
  // 三位或四位相同数字 (111, 222, 1111, 2222)
  if (str.length >= 3) {
    const firstDigit = str[0];
    if (str.split('').every(d => d === firstDigit)) {
      return { notable: true, reason: '重复数字' };
    }
  }
  
  // 连续数字 (123, 234, 1234, 2345)
  if (str.length >= 3) {
    let isSequential = true;
    for (let i = 1; i < str.length; i++) {
      if (parseInt(str[i]) !== parseInt(str[i-1]) + 1) {
        isSequential = false;
        break;
      }
    }
    if (isSequential) {
      return { notable: true, reason: '连续数字' };
    }
  }
  
  // 回文数字 (121, 131, 1221, 1331)
  if (str.length >= 3 && str === str.split('').reverse().join('')) {
    return { notable: true, reason: '回文' };
  }
  
  // 特殊数字（素数、著名数字等）
  const specialNumbers = [
    13, 42, 69, 88, 99, 101, 111, 123, 144, 169, 200, 222, 256, 300, 333, 365, 404, 420, 444, 500, 555, 600, 666, 700, 777, 800, 888, 900, 999,
    1000, 1111, 1234, 1337, 1500, 1600, 1700, 1800, 1900, 2000, 2222, 2500, 3000, 3333, 4000, 4444, 5000
  ];
  
  if (specialNumbers.includes(num)) {
    return { notable: true, reason: '特殊数字' };
  }
  
  return { notable: false };
}

/**
 * 显示值得关注的未使用编号
 */
async function showNotableUnusedNumbers(prisma: PrismaClient, openSeries: any[]) {
  if (openSeries.length === 0) return;
  
  console.log('\n=== 值得关注的空编号 ===');
  
  // Get all used numbers from all open series
  const scpPages = await prisma.$queryRaw<Array<{url: string}>>`
    SELECT p.url
    FROM "Page" p
    INNER JOIN "PageVersion" pv ON p.id = pv."pageId"
    WHERE pv."validTo" IS NULL 
      AND pv."isDeleted" = false
      AND p.url ~ '/scp-cn-[0-9]{3,4}($|/)'
      AND p.url NOT LIKE '%deleted:%'
      AND '原创' = ANY(pv.tags)
      AND NOT ('待删除' = ANY(pv.tags))
      AND NOT ('待刪除' = ANY(pv.tags))
  `;
  
  const usedNumbers = new Set<number>();
  for (const page of scpPages) {
    const match = page.url.match(/\/scp-cn-(\d{3,4})(?:$|\/)/);
    if (match) {
      const num = parseInt(match[1]);
      if (num >= 1) {
        usedNumbers.add(num);
      }
    }
  }
  
  // Check each open series for notable unused numbers
  for (const series of openSeries) {
    let start: number, end: number;
    
    if (series.seriesNumber === 1) {
      start = 2;
      end = 999;
    } else {
      start = (series.seriesNumber - 1) * 1000;
      end = series.seriesNumber * 1000 - 1;
    }
    
    const notableUnused: Array<{num: number, reason: string}> = [];
    
    for (let i = start; i <= end; i++) {
      if (!usedNumbers.has(i)) {
        const check = isNotableNumber(i);
        if (check.notable) {
          notableUnused.push({ num: i, reason: check.reason! });
        }
      }
    }
    
    if (notableUnused.length > 0) {
      // Sort by number
      notableUnused.sort((a, b) => a.num - b.num);
      
      // Group by reason
      const byReason = new Map<string, number[]>();
      for (const item of notableUnused) {
        if (!byReason.has(item.reason)) {
          byReason.set(item.reason, []);
        }
        byReason.get(item.reason)!.push(item.num);
      }
      
      console.log(`\n📋 系列${series.seriesNumber} 值得关注的空编号 (共${notableUnused.length}个):`);
      
      for (const [reason, numbers] of byReason.entries()) {
        const displayNumbers = numbers.slice(0, 10); // Show first 10
        const hasMore = numbers.length > 10;
        console.log(`  ${reason}: ${displayNumbers.join(', ')}${hasMore ? ` ... (+${numbers.length - 10}个)` : ''}`);
      }
    } else {
      // If no notable numbers, show sample unused numbers
      const totalUnused = series.totalSlots - series.usedSlots;
      if (totalUnused > 0) {
        const sampleUnused: number[] = [];
        for (let i = start; i <= end && sampleUnused.length < 20; i++) {
          if (!usedNumbers.has(i)) {
            sampleUnused.push(i);
          }
        }
        
        if (sampleUnused.length > 0) {
          console.log(`\n📋 系列${series.seriesNumber} 样例空编号 (共${totalUnused}个未使用):`);
          const displayCount = Math.min(15, sampleUnused.length);
          const displayed = sampleUnused.slice(0, displayCount);
          const hasMore = sampleUnused.length > displayCount;
          console.log(`  ${displayed.join(', ')}${hasMore ? ` ... (+${totalUnused - displayCount}个)` : ''}`);
        }
      }
    }
  }
}

export async function query({ 
  url, 
  user, 
  stats, 
  userRank, 
  votePattern,
  voteInteractions,
  popularTags,
  siteStats,
  seriesStats,
  historical,
  days,
  category,
  help 
}: { 
  url?: string; 
  user?: string; 
  stats?: boolean; 
  userRank?: boolean;
  votePattern?: boolean;
  voteInteractions?: boolean;
  popularTags?: boolean;
  siteStats?: boolean;
  seriesStats?: boolean;
  historical?: boolean;
  days?: string;
  category?: string;
  help?: boolean;
}) {
  if (help) {
    console.log(`
SCPPER-CN Query Tool - 数据查询工具

使用方法:
  npm run query [选项]

页面查询:
  --url <url或UUID>     查询指定页面的版本信息和统计数据
                        支持URL、页面UUID或历史URL查询

用户查询:
  --user <用户名>       查询指定用户信息
  --vote-pattern        显示用户投票模式分析

统计信息:
  --stats               显示数据库统计和热门页面
  --user-rank           显示用户排行榜
  --category <类别>     指定排行榜类别 (overall, scp, translation, goi, story)
  --vote-interactions   显示最活跃投票交互
  --popular-tags        显示热门标签统计

全站统计:
  --site-stats          显示全站统计信息和趋势
  --series-stats        显示SCP-CN编号系列详细统计 (包括占用情况、评分统计、标签分布、值得关注的空编号)
  --historical          显示历史趋势 (需要配合--site-stats使用)
  --days <天数>         历史数据天数 (默认30天)

示例:
  npm run query -- --url scp-173
  npm run query -- --url 12345678-1234-1234-1234-123456789012  # UUID查询
  npm run query -- --url http://scp-wiki-cn.wikidot.com/old-url  # 历史URL查询
  npm run query -- --user "某用户名"
  npm run query -- --user "某用户名" --vote-pattern
  npm run query -- --stats
  npm run query -- --user-rank --category scp
  npm run query -- --vote-interactions
  npm run query -- --popular-tags
  npm run query -- --site-stats
  npm run query -- --series-stats
  npm run query -- --site-stats --historical --days 7

快捷方式:
  npm run query:help       显示此帮助信息
  npm run query:stats      显示统计信息
  npm run query:rankings   显示用户排行榜
`);
    return;
  }

  const prisma = new PrismaClient();

  try {
    if (url) {
      // Use DatabaseStore to find page by UUID or URL
      const dbStore = new DatabaseStore();
      const page = await dbStore.findPageByIdentifier(url);
      
      if (!page) {
        console.log(`Page not found: ${url}`);
        await dbStore.disconnect();
        return;
      }
      
      // Get full page data including relations
      const fullPage = await prisma.page.findUnique({
        where: { id: page.id },
        include: {
          versions: {
            include: { 
              stats: true,
              attributions: {
                include: {
                  user: true
                },
                orderBy: { order: 'asc' }
              },
              revisions: {
                include: {
                  user: true
                },
                orderBy: { timestamp: 'desc' },
                take: 10
              },
              votes: {
                include: {
                  user: true
                },
                orderBy: { timestamp: 'desc' },
                take: 20
              }
            },
            orderBy: { validFrom: 'desc' }
          }
        }
      });
      
      await dbStore.disconnect();

      if (!fullPage) {
        console.log('Could not load full page data');
        return;
      }

      // Basic page info
      const currentVersion = fullPage.versions.find(v => v.validTo === null) || fullPage.versions[0];
      console.log(`\n=== Page Information ===`);
      console.log(`URL: ${page.url}`);
      console.log(`Page UUID: ${page.pageUuid || 'N/A'}`);
      console.log(`URL Key: ${page.urlKey}`);
      if (page.historicalUrls && page.historicalUrls.length > 0) {
        console.log(`Historical URLs: ${page.historicalUrls.join(', ')}`);
      }
      if (currentVersion) {
        console.log(`Title: ${currentVersion.title || 'Untitled'}`);
        console.log(`Category: ${currentVersion.category || 'Unknown'}`);
        console.log(`Tags: ${currentVersion.tags?.join(', ') || 'None'}`);
        console.log(`Rating: ${currentVersion.rating || 0}`);
        console.log(`Vote Count: ${currentVersion.voteCount || 0}`);
        console.log(`Revision Count: ${currentVersion.revisionCount || 0}`);
        console.log(`Comment Count: ${currentVersion.commentCount || 0}`);
        if (currentVersion.stats) {
          console.log(`Wilson Score: ${currentVersion.stats.wilson95?.toFixed(3) || '—'}`);
          console.log(`Controversy: ${currentVersion.stats.controversy?.toFixed(3) || '—'}`);
        }
        console.log(`Created At: ${currentVersion.createdAt?.toISOString() || 'Unknown'}`);
        console.log(`Is Hidden: ${currentVersion.isHidden}`);
        console.log(`Is Deleted: ${currentVersion.isDeleted}`);
      }

      // Version history table
      console.log(`\n=== Version History ===`);
      console.log(table([
        ['Version ID', 'Valid Period', 'Rating', 'RCnt', 'VCnt', 'Wilson', 'Controversy', 'Deleted'],
        ...fullPage.versions.map(v => [
          v.id.toString(),
          `${v.validFrom.toISOString().split('T')[0]} ⇢ ${v.validTo ? v.validTo.toISOString().split('T')[0] : 'now'}`,
          v.rating?.toString() || '—',
          v.revisionCount?.toString() || '—',
          v.voteCount?.toString() || '—',
          v.stats?.wilson95?.toFixed(3) || '—', 
          v.stats?.controversy?.toFixed(3) || '—',
          v.isDeleted.toString()
        ])
      ]));

      // Attributions for current version
      if (currentVersion?.attributions && currentVersion.attributions.length > 0) {
        console.log(`\n=== Attributions ===`);
        console.log(table([
          ['Type', 'User', 'Date', 'Order'],
          ...currentVersion.attributions.map(attr => [
            attr.type || 'Unknown',
            attr.user?.displayName || 'Unknown User',
            attr.date?.toISOString().split('T')[0] || '—',
            attr.order?.toString() || '—'
          ])
        ]));
      }

      // Recent revisions for current version
      if (currentVersion?.revisions && currentVersion.revisions.length > 0) {
        console.log(`\n=== Recent Revisions (Latest 10) ===`);
        console.log(table([
          ['Date', 'User', 'Type', 'Comment'],
          ...currentVersion.revisions.map(rev => [
            rev.timestamp?.toISOString().split('T')[0] || '—',
            rev.user?.displayName || 'Unknown User',
            rev.type || 'Unknown',
            (rev.comment || '').substring(0, 50) + (rev.comment && rev.comment.length > 50 ? '...' : '')
          ])
        ]));
      }

      // Recent votes for current version (sample)
      if (currentVersion?.votes && currentVersion.votes.length > 0) {
        console.log(`\n=== Recent Votes (Latest 20) ===`);
        console.log(table([
          ['Date', 'User', 'Direction'],
          ...currentVersion.votes.map(vote => [
            vote.timestamp?.toISOString().split('T')[0] || '—',
            vote.user?.displayName || 'Unknown User',
            vote.direction > 0 ? '+1' : vote.direction < 0 ? '-1' : '0'
          ])
        ]));
      }
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
            take: 20, // Get more records first, then sort and limit  
            include: { 
              pageVersion: { 
                include: { 
                  page: true,
                  revisions: {
                    orderBy: { timestamp: 'asc' },
                    take: 1
                  }
                } 
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
      if (userData.firstActivityAt) {
        const activityDate = userData.firstActivityAt.toISOString().split('T')[0];
        const activityType = userData.firstActivityType || 'Unknown';
        const activityDetails = userData.firstActivityDetails || '未知活动';
        console.log(`First Activity: ${activityDate} (${activityType})`);
        console.log(`Activity Details: ${activityDetails}`);
      }
      
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
          ],
          [
            'Wanderers',
            userData.stats.wanderersRating?.toString() || '—',
            userData.stats.wanderersRank?.toString() || '—',
            userData.stats.wanderersPageCount.toString()
          ],
          [
            'Art',
            userData.stats.artRating?.toString() || '—',
            userData.stats.artRank?.toString() || '—',
            userData.stats.artPageCount.toString()
          ]
        ]));
        
        if (userData.stats.ratingUpdatedAt) {
          console.log(`Ratings last updated: ${userData.stats.ratingUpdatedAt.toISOString()}`);
        }
      }

      // 显示用户投票模式信息
      if (votePattern) {
        const ratingSystem = new UserRatingSystem(prisma);
        const pattern = await ratingSystem.getUserVotePattern(userData.id);
        
        if (pattern.voteTargets.length > 0) {
          console.log('\n=== 投票目标 Top5 (我投票给谁最多) ===');
          console.log(table([
            ['用户', 'Wikidot ID', '总票数', '↑票', '↓票', '最后投票'],
            ...pattern.voteTargets.map(target => [
              target.displayName || 'Unknown',
              target.wikidotId?.toString() || '—',
              target.totalVotes.toString(),
              target.upvoteCount.toString(),
              target.downvoteCount.toString(),
              target.lastVoteAt?.toISOString().split('T')[0] || '—'
            ])
          ]));
        }

        if (pattern.voteSources.length > 0) {
          console.log('\n=== 投票来源 Top5 (谁投票给我最多) ===');
          console.log(table([
            ['用户', 'Wikidot ID', '总票数', '↑票', '↓票', '最后投票'],
            ...pattern.voteSources.map(source => [
              source.displayName || 'Unknown',
              source.wikidotId?.toString() || '—',
              source.totalVotes.toString(),
              source.upvoteCount.toString(),
              source.downvoteCount.toString(),
              source.lastVoteAt?.toISOString().split('T')[0] || '—'
            ])
          ]));
        }

        if (pattern.tagPreferences.length > 0) {
          console.log('\n=== 标签偏好 Top10 ===');
          console.log(table([
            ['标签', '总票数', '↑票', '↓票', '赞成率%', '最后投票'],
            ...pattern.tagPreferences.map(pref => [
              pref.tag,
              pref.totalVotes.toString(),
              pref.upvoteCount.toString(),
              pref.downvoteCount.toString(),
              (pref.upvoteRatio * 100).toFixed(1),
              pref.lastVoteAt?.toISOString().split('T')[0] || '—'
            ])
          ]));
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
        // Sort attributions by the actual date we're displaying (date || earliest revision || validFrom)
        const sortedAttributions = userData.attributions
          .map(attr => ({
            ...attr,
            displayDate: attr.date || attr.pageVersion.revisions[0]?.timestamp || attr.pageVersion.validFrom
          }))
          .sort((a, b) => {
            if (!a.displayDate && !b.displayDate) return 0;
            if (!a.displayDate) return 1;
            if (!b.displayDate) return -1;
            return new Date(b.displayDate).getTime() - new Date(a.displayDate).getTime();
          })
          .slice(0, 10); // Take top 10 after sorting

        console.log('\nRecent Attributions:');
        console.log(table([
          ['Type', 'Page Title', 'Page ID', 'Date'],
          ...sortedAttributions.map(attr => [
            attr.type || 'Unknown',
            attr.pageVersion.title || 'Untitled',
            attr.pageVersion.page.url.split('/').pop() || 'Unknown',
            attr.displayDate?.toISOString().split('T')[0] || '—'
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
      const validCategories = ['overall', 'scp', 'translation', 'goi', 'story', 'wanderers', 'art'];
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
        case 'wanderers':
          orderBy = { wanderersRank: 'asc' };
          ratingField = 'wanderersRating';
          rankField = 'wanderersRank';
          pageCountField = 'wanderersPageCount';
          break;
        case 'art':
          orderBy = { artRank: 'asc' };
          ratingField = 'artRating';
          rankField = 'artRank';
          pageCountField = 'artPageCount';
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

    if (voteInteractions) {
      const ratingSystem = new UserRatingSystem(prisma);
      const interactions = await ratingSystem.getTopVoteInteractions(20);
      
      if (interactions.length === 0) {
        console.log('No vote interaction data available. Run analysis first.');
        return;
      }

      console.log('\n=== 最活跃投票交互 Top20 ===');
      console.log(table([
        ['投票者', '页面作者', '总票数', '↑票', '↓票', '相互投票'],
        ...interactions.map(interaction => [
          interaction.fromDisplayName || 'Unknown',
          interaction.toDisplayName || 'Unknown',
          interaction.totalVotes.toString(),
          interaction.upvoteCount.toString(),
          interaction.downvoteCount.toString(),
          interaction.mutualVotes?.toString() || '—'
        ])
      ]));
      
      console.log('\n说明: "相互投票"显示对方回投的票数，可用于发现潜在的相互投票行为');
    }

    if (popularTags) {
      const ratingSystem = new UserRatingSystem(prisma);
      const tags = await ratingSystem.getPopularTags(20);
      
      if (tags.length === 0) {
        console.log('No tag preference data available. Run analysis first.');
        return;
      }

      console.log('\n=== 热门标签统计 Top20 ===');
      console.log(table([
        ['标签', '投票人数', '总票数', '↑票', '↓票', '平均赞成率%'],
        ...tags.map(tag => [
          tag.tag,
          Number(tag.totalVoters).toString(),
          Number(tag.totalVotes).toString(),
          Number(tag.totalUpvotes).toString(),
          Number(tag.totalDownvotes).toString(),
          (tag.avgUpvoteRatio * 100).toFixed(1)
        ])
      ]));
      
      console.log('\n说明: 显示按总投票数排序的标签，"平均赞成率"反映该标签内容的受欢迎程度');
    }

    if (siteStats) {
      const daysNum = parseInt(days || '30');
      
      if (historical) {
        console.log(`\n=== 最近${daysNum}天站点趋势 ===`);
        
        const historicalData = await prisma.siteStats.findMany({
          where: {
            date: {
              gte: new Date(Date.now() - daysNum * 24 * 60 * 60 * 1000)
            }
          },
          orderBy: { date: 'desc' },
          take: daysNum
        });

        if (historicalData.length === 0) {
          console.log('暂无历史数据。请先运行 npm run analyze 生成统计数据。');
        } else {
          console.log(table([
            ['日期', '总用户', '活跃用户', '总页面', '总投票', '新用户', '新页面', '新投票'],
            ...historicalData.reverse().map(stat => [
              stat.date.toISOString().split('T')[0],
              stat.totalUsers.toString(),
              stat.activeUsers.toString(),
              stat.totalPages.toString(),
              stat.totalVotes.toString(),
              stat.newUsersToday.toString(),
              stat.newPagesToday.toString(),
              stat.newVotesToday.toString()
            ])
          ]));
        }
      } else {
        console.log('\n=== 当前站点统计 ===');
        
        const latestStats = await prisma.siteStats.findFirst({
          orderBy: { date: 'desc' }
        });

        if (!latestStats) {
          console.log('暂无统计数据。请先运行 npm run analyze 生成统计数据。');
        } else {
          console.log(`统计日期: ${latestStats.date.toISOString().split('T')[0]}`);
          console.log(`总用户数: ${latestStats.totalUsers}`);
          console.log(`活跃用户数: ${latestStats.activeUsers} (${(latestStats.activeUsers / latestStats.totalUsers * 100).toFixed(1)}%)`);
          console.log(`总页面数: ${latestStats.totalPages}`);
          console.log(`总投票数: ${latestStats.totalVotes}`);
          
          if (latestStats.newUsersToday > 0 || latestStats.newPagesToday > 0 || latestStats.newVotesToday > 0) {
            console.log(`\n当日新增:`);
            console.log(`  新用户: ${latestStats.newUsersToday}`);
            console.log(`  新页面: ${latestStats.newPagesToday}`);
            console.log(`  新投票: ${latestStats.newVotesToday}`);
          }
        }

        // Additional comprehensive site statistics
        console.log('\n=== 详细站点分析 ===');
        
        // Content distribution by category (derived from tags, consistent with UserRatingJob)
        const categoryStats = await prisma.$queryRaw`
          SELECT 
            CASE 
              -- 原创SCP分类 (原创 + scp)
              WHEN tags @> ARRAY['原创', 'scp'] THEN 'SCP'
              -- 原创GOI格式分类 (原创 + goi格式)
              WHEN tags @> ARRAY['原创', 'goi格式'] THEN 'GOI格式'
              -- 原创故事分类 (原创 + 故事)
              WHEN tags @> ARRAY['原创', '故事'] THEN '故事'
              -- 原创Wanderers分类 (原创 + wanderers)
              WHEN tags @> ARRAY['原创', 'wanderers'] THEN 'Wanderers'
              -- 原创艺术作品分类 (原创 + 艺术作品)
              WHEN tags @> ARRAY['原创', '艺术作品'] THEN '艺术作品'
              -- 翻译分类 (不包含原创和掩藏页的页面)
              WHEN NOT (tags @> ARRAY['原创']) AND NOT (tags @> ARRAY['掩藏页']) THEN '翻译'
              ELSE '其他'
            END as category,
            COUNT(*) as page_count,
            AVG(pv.rating::float) as avg_rating,
            SUM(pv."voteCount") as total_votes,
            MAX(pv.rating) as max_rating,
            MIN(pv.rating) as min_rating
          FROM "PageVersion" pv
          WHERE pv."validTo" IS NULL 
            AND pv."isDeleted" = false
            AND pv.rating IS NOT NULL
          GROUP BY category
          ORDER BY page_count DESC
          LIMIT 10
        `;

        if (Array.isArray(categoryStats) && categoryStats.length > 0) {
          console.log('\n--- 页面分类统计 ---');
          console.log(table([
            ['分类', '页面数', '平均分', '总投票数', '最高分', '最低分'],
            ...(categoryStats as any[]).map(cat => [
              cat.category || 'Unknown',
              Number(cat.page_count).toString(),
              cat.avg_rating ? Number(cat.avg_rating).toFixed(1) : '—',
              Number(cat.total_votes || 0).toString(),
              Number(cat.max_rating || 0).toString(),
              Number(cat.min_rating || 0).toString()
            ])
          ]));
        }

        // Most popular tags
        const popularTags = await prisma.$queryRaw`
          SELECT 
            tag,
            COUNT(*) as page_count,
            AVG(pv.rating::float) as avg_rating,
            SUM(pv."voteCount") as total_votes
          FROM "PageVersion" pv,
               unnest(pv.tags) as tag
          WHERE pv."validTo" IS NULL 
            AND pv."isDeleted" = false
            AND pv.rating IS NOT NULL
            AND array_length(pv.tags, 1) > 0
          GROUP BY tag
          ORDER BY page_count DESC
          LIMIT 15
        `;

        if (Array.isArray(popularTags) && popularTags.length > 0) {
          console.log('\n--- 热门标签统计 ---');
          console.log(table([
            ['标签', '页面数', '平均分', '总投票数'],
            ...(popularTags as any[]).map(tag => [
              tag.tag,
              Number(tag.page_count).toString(),
              tag.avg_rating ? Number(tag.avg_rating).toFixed(1) : '—',
              Number(tag.total_votes || 0).toString()
            ])
          ]));
        }

        // Rating distribution
        const ratingDistribution = await prisma.$queryRaw`
          SELECT 
            rating_range,
            COUNT(*) as page_count,
            AVG(rating_val::float) as avg_rating_in_range
          FROM (
            SELECT 
              rating as rating_val,
              CASE 
                WHEN rating >= 200 THEN '200+'
                WHEN rating >= 100 THEN '100-199'
                WHEN rating >= 50 THEN '50-99' 
                WHEN rating >= 20 THEN '20-49'
                WHEN rating >= 10 THEN '10-19'
                WHEN rating >= 5 THEN '5-9'
                WHEN rating >= 0 THEN '0-4'
                WHEN rating >= -10 THEN '-1 to -10'
                ELSE '-11 or lower'
              END as rating_range
            FROM "PageVersion" pv
            WHERE pv."validTo" IS NULL 
              AND pv."isDeleted" = false
              AND pv.rating IS NOT NULL
          ) subq
          GROUP BY rating_range
          ORDER BY 
            CASE rating_range
              WHEN '200+' THEN 1
              WHEN '100-199' THEN 2
              WHEN '50-99' THEN 3
              WHEN '20-49' THEN 4
              WHEN '10-19' THEN 5
              WHEN '5-9' THEN 6
              WHEN '0-4' THEN 7
              WHEN '-1 to -10' THEN 8
              ELSE 9
            END
        `;

        if (Array.isArray(ratingDistribution) && ratingDistribution.length > 0) {
          console.log('\n--- 评分分布统计 ---');
          console.log(table([
            ['评分区间', '页面数', '区间内平均分', '占比%'],
            ...(ratingDistribution as any[]).map(range => {
              const totalPages = (ratingDistribution as any[]).reduce((sum, r) => sum + Number(r.page_count), 0);
              const percentage = (Number(range.page_count) / totalPages * 100).toFixed(1);
              return [
                range.rating_range,
                Number(range.page_count).toString(),
                range.avg_rating_in_range ? Number(range.avg_rating_in_range).toFixed(1) : '—',
                percentage
              ];
            })
          ]));
        }

        // Top contributors (most active authors) with their highest-rated page URL
        const topContributors = await prisma.$queryRaw`
          WITH author_stats AS (
            SELECT 
              u.id as user_id,
              u."displayName",
              u."wikidotId",
              COUNT(DISTINCT a."pageVerId") as authored_pages,
              AVG(pv.rating::float) as avg_rating,
              SUM(pv.rating) as total_rating
            FROM "User" u
            INNER JOIN "Attribution" a ON u.id = a."userId"
            INNER JOIN "PageVersion" pv ON a."pageVerId" = pv.id  
            WHERE pv."validTo" IS NULL 
              AND pv."isDeleted" = false
              AND pv.rating IS NOT NULL
              AND a.type IN ('AUTHOR', 'CO_AUTHOR', 'SUBMITTER')
              AND pv.tags @> ARRAY['原创']
            GROUP BY u.id, u."displayName", u."wikidotId"
            HAVING COUNT(DISTINCT a."pageVerId") >= 3
          ),
          highest_rated_pages AS (
            SELECT DISTINCT ON (u.id)
              u.id as user_id,
              p.url,
              pv.rating as highest_rating
            FROM "User" u
            INNER JOIN "Attribution" a ON u.id = a."userId"
            INNER JOIN "PageVersion" pv ON a."pageVerId" = pv.id
            INNER JOIN "Page" p ON pv."pageId" = p.id
            WHERE pv."validTo" IS NULL 
              AND pv."isDeleted" = false
              AND pv.rating IS NOT NULL
              AND a.type IN ('AUTHOR', 'CO_AUTHOR', 'SUBMITTER')
              AND pv.tags @> ARRAY['原创']
            ORDER BY u.id, pv.rating DESC, pv.id ASC
          )
          SELECT 
            ast."displayName",
            ast."wikidotId",
            ast.authored_pages,
            ast.avg_rating,
            ast.total_rating,
            REGEXP_REPLACE(hrp.url, '^https?://[^/]+/', '') as highest_rated_page_url
          FROM author_stats ast
          INNER JOIN highest_rated_pages hrp ON ast.user_id = hrp.user_id
          ORDER BY ast.authored_pages DESC, ast.total_rating DESC
          LIMIT 15
        `;

        if (Array.isArray(topContributors) && topContributors.length > 0) {
          console.log('\n--- 顶级创作者 (3+作品) ---');
          console.log(table([
            ['作者', '作品数', '平均分', '总评分', '最高分作品'],
            ...(topContributors as any[]).map(author => [
              author.displayName || 'Unknown',
              Number(author.authored_pages).toString(),
              author.avg_rating ? Number(author.avg_rating).toFixed(1) : '—',
              Number(author.total_rating || 0).toString(),
              author.highest_rated_page_url || '—'
            ])
          ]));
        }

        // Recent activity summary (last 30 days) - optimized separate queries
        const [voteActivity, revisionActivity, pageActivity] = await Promise.all([
          prisma.$queryRaw`
            SELECT 
              COUNT(DISTINCT "userId") as active_voters_30d,
              COUNT(*) as votes_30d
            FROM "Vote" 
            WHERE "timestamp" >= NOW() - INTERVAL '30 days'
          `,
          prisma.$queryRaw`
            SELECT COUNT(*) as revisions_30d
            FROM "Revision" 
            WHERE "timestamp" >= NOW() - INTERVAL '30 days'
          `,
          prisma.$queryRaw`
            SELECT COUNT(*) as new_pages_30d
            FROM "PageVersion" pv
            WHERE pv."validTo" IS NULL
              AND pv."isDeleted" = false
              AND EXISTS (
                SELECT 1 FROM "Revision" r 
                WHERE r."pageVersionId" = pv.id 
                  AND r."timestamp" >= NOW() - INTERVAL '30 days'
                  AND r."timestamp" = (
                    SELECT MIN(r2."timestamp") 
                    FROM "Revision" r2 
                    WHERE r2."pageVersionId" = pv.id
                  )
              )
          `
        ]);
        
        const recentActivity = [{
          active_voters_30d: (voteActivity as any[])[0]?.active_voters_30d || 0,
          votes_30d: (voteActivity as any[])[0]?.votes_30d || 0,
          revisions_30d: (revisionActivity as any[])[0]?.revisions_30d || 0,
          new_pages_30d: (pageActivity as any[])[0]?.new_pages_30d || 0
        }];

        if (Array.isArray(recentActivity) && recentActivity.length > 0) {
          const activity = (recentActivity as any[])[0];
          console.log('\n--- 最近30天活动摘要 ---');
          console.log(`活跃投票用户: ${Number(activity.active_voters_30d || 0)}`);
          console.log(`新增投票: ${Number(activity.votes_30d || 0)}`);
          console.log(`页面修订: ${Number(activity.revisions_30d || 0)}`);
          console.log(`新建页面: ${Number(activity.new_pages_30d || 0)}`);
        }
      }
    }

    if (seriesStats) {
      console.log('\n=== SCP-CN编号系列占用情况 ===');
      
      const seriesData = await prisma.seriesStats.findMany({
        orderBy: { seriesNumber: 'asc' }
      });

      if (seriesData.length === 0) {
        console.log('暂无系列统计数据。请先运行 npm run analyze 生成统计数据。');
      } else {
        console.log(table([
          ['系列', '状态', '已用/总数', '使用率', '剩余槽位', '最后更新'],
          ...seriesData.map(series => [
            `系列${series.seriesNumber}`,
            series.isOpen ? '🟢 开放' : '🔴 未开放',
            `${series.usedSlots}/${series.totalSlots}`,
            `${series.usagePercentage.toFixed(1)}%`,
            (series.totalSlots - series.usedSlots).toString(),
            series.lastUpdated.toISOString().split('T')[0]
          ])
        ]));

        // Show warnings for nearly full series
        const nearlyFull = seriesData.filter(s => s.isOpen && s.usagePercentage > 80);
        if (nearlyFull.length > 0) {
          console.log('\n⚠️  系列使用率警告:');
          nearlyFull.forEach(series => {
            const remaining = series.totalSlots - series.usedSlots;
            console.log(`  系列${series.seriesNumber}: 仅剩 ${remaining} 个编号 (${series.usagePercentage.toFixed(1)}% 已使用)`);
          });
        }

        // Enhanced statistics for each series
        console.log('\n=== 系列评分统计 ===');
        
        for (const series of seriesData) {
          // Calculate rating statistics for each series
          let startNum: number, endNum: number;
          
          if (series.seriesNumber === 1) {
            startNum = 2;
            endNum = 999;
          } else {
            startNum = (series.seriesNumber - 1) * 1000;
            endNum = series.seriesNumber * 1000 - 1;
          }

          const ratingStats = await prisma.$queryRaw<Array<{
            max_rating: number | null;
            min_rating: number | null;
            avg_rating: number | null;
            median_rating: number | null;
            total_votes: bigint | null;
            page_count: bigint;
          }>>`
            SELECT 
              MAX(pv.rating) as max_rating,
              MIN(pv.rating) as min_rating,
              AVG(pv.rating::float) as avg_rating,
              PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY pv.rating) as median_rating,
              SUM(pv."voteCount") as total_votes,
              COUNT(*) as page_count
            FROM "PageVersion" pv
            INNER JOIN "Page" p ON pv."pageId" = p.id
            WHERE pv."validTo" IS NULL 
              AND pv."isDeleted" = false
              AND pv.rating IS NOT NULL
              AND p.url ~ '/scp-cn-[0-9]{3,4}($|/)'
              AND p.url NOT LIKE '%deleted:%'
              AND '原创' = ANY(pv.tags)
              AND NOT ('待删除' = ANY(pv.tags))
              AND NOT ('待刪除' = ANY(pv.tags))
              AND CAST(SUBSTRING(p.url FROM '/scp-cn-([0-9]{3,4})(?:$|/)') AS INTEGER) BETWEEN ${startNum} AND ${endNum}
          `;

          if (ratingStats.length > 0 && Number(ratingStats[0].page_count) > 0) {
            const stats = ratingStats[0];
            console.log(`\n📊 系列${series.seriesNumber} 评分统计:`);
            console.log(table([
              ['指标', '值'],
              ['页面数量', Number(stats.page_count).toString()],
              ['最高分', stats.max_rating?.toString() || '—'],
              ['最低分', stats.min_rating?.toString() || '—'],
              ['平均分', stats.avg_rating ? Number(stats.avg_rating).toFixed(1) : '—'],
              ['中位数', stats.median_rating ? Number(stats.median_rating).toFixed(1) : '—'],
              ['总投票数', stats.total_votes ? Number(stats.total_votes).toString() : '—']
            ]));

            // Tag distribution for this series
            const tagStats = await prisma.$queryRaw<Array<{
              tag: string;
              page_count: bigint;
              avg_rating: number | null;
            }>>`
              SELECT 
                tag,
                COUNT(*) as page_count,
                AVG(pv.rating::float) as avg_rating
              FROM "PageVersion" pv
              INNER JOIN "Page" p ON pv."pageId" = p.id,
              unnest(pv.tags) as tag
              WHERE pv."validTo" IS NULL 
                AND pv."isDeleted" = false
                AND pv.rating IS NOT NULL
                AND p.url ~ '/scp-cn-[0-9]{3,4}($|/)'
                AND p.url NOT LIKE '%deleted:%'
                AND '原创' = ANY(pv.tags)
                AND NOT ('待删除' = ANY(pv.tags))
                AND NOT ('待刪除' = ANY(pv.tags))
                AND tag != '原创'
                AND CAST(SUBSTRING(p.url FROM '/scp-cn-([0-9]{3,4})(?:$|/)') AS INTEGER) BETWEEN ${startNum} AND ${endNum}
              GROUP BY tag
              ORDER BY page_count DESC, avg_rating DESC NULLS LAST
              LIMIT 10
            `;

            if (tagStats.length > 0) {
              console.log(`\n🏷️  系列${series.seriesNumber} 标签分布 (Top 10):`);
              console.log(table([
                ['标签', '页面数', '平均分', '占比%'],
                ...tagStats.map(tag => [
                  tag.tag,
                  Number(tag.page_count).toString(),
                  tag.avg_rating ? Number(tag.avg_rating).toFixed(1) : '—',
                  (Number(tag.page_count) / Number(stats.page_count) * 100).toFixed(1)
                ])
              ]));
            }
          } else if (series.isOpen) {
            console.log(`\n📊 系列${series.seriesNumber}: 暂无评分数据 (系列已开放但无有效页面)`);
          }
        }

        // Show notable unused numbers for open series
        await showNotableUnusedNumbers(prisma, seriesData.filter(s => s.isOpen));

        // Show next series status
        const maxSeries = Math.max(...seriesData.map(s => s.seriesNumber));
        const nextSeries = maxSeries + 1;
        console.log(`\n📈 下一个系列: 系列${nextSeries} (需要创建 scp-cn-${nextSeries * 1000} 开启)`);
      }
    }
  } catch (error) {
    console.error('Query failed:', error);
  } finally {
    await prisma.$disconnect();
  }
}

// 如果直接运行此文件，处理命令行参数
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  
  // 解析参数
  const options: any = {};
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--url') {
      options.url = args[++i];
    } else if (arg === '--user') {
      options.user = args[++i];
    } else if (arg === '--stats') {
      options.stats = true;
    } else if (arg === '--user-rank') {
      options.userRank = true;
    } else if (arg === '--vote-pattern') {
      options.votePattern = true;
    } else if (arg === '--vote-interactions') {
      options.voteInteractions = true;
    } else if (arg === '--popular-tags') {
      options.popularTags = true;
    } else if (arg === '--site-stats') {
      options.siteStats = true;
    } else if (arg === '--series-stats') {
      options.seriesStats = true;
    } else if (arg === '--historical') {
      options.historical = true;
    } else if (arg === '--days') {
      options.days = args[++i];
    } else if (arg === '--category') {
      options.category = args[++i];
    }
  }

  query(options)
    .then(() => {
      process.exit(0);
    })
    .catch((error) => {
      console.error('Query failed:', error);
      process.exit(1);
    });
}
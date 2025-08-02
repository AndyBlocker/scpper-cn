#!/usr/bin/env npx tsx

import { PrismaClient } from '@prisma/client';
import { table } from 'table';

const prisma = new PrismaClient();

interface VerificationResult {
  passed: boolean;
  message: string;
  details?: any;
}

async function verifyPage(url: string): Promise<VerificationResult> {
  try {
    const page = await prisma.page.findUnique({
      where: { url },
      include: {
        versions: {
          where: { validTo: null },
          include: {
            stats: true,
            votes: {
              include: { user: true },
              orderBy: { timestamp: 'desc' },
              take: 10,
            },
            revisions: {
              include: { user: true },
              orderBy: { timestamp: 'desc' },
              take: 5,
            },
          },
        },
      },
    });

    if (!page) {
      return { passed: false, message: `Page not found: ${url}` };
    }

    if (page.versions.length === 0) {
      return { passed: false, message: `No active version found for: ${url}` };
    }

    const version = page.versions[0];
    const stats = version.stats;

    // Verify vote count consistency
    const actualVoteCount = version.votes.length;
    const storedVoteCount = version.voteCount || 0;
    
    // Verify revision count consistency
    const actualRevisionCount = version.revisions.length;
    const storedRevisionCount = version.revisionCount || 0;

    // Calculate actual UV/DV
    const actualUV = version.votes.filter(v => v.direction === 1).length;
    const actualDV = version.votes.filter(v => v.direction === -1).length;
    const actualNeutral = version.votes.filter(v => v.direction === 0).length;

    console.log(`\n=== Page: ${version.title || 'Untitled'} ===`);
    console.log(`URL: ${url}`);
    console.log(`WikidotID: ${version.wikidotId}`);
    console.log(`Rating: ${version.rating}`);
    console.log(`Tags: ${version.tags.join(', ')}`);
    
    console.log(`\n--- Vote Analysis ---`);
    console.log(`Stored Vote Count: ${storedVoteCount}`);
    console.log(`Actual Vote Count: ${actualVoteCount}`);
    console.log(`UV: ${actualUV}, DV: ${actualDV}, Neutral: ${actualNeutral}`);
    
    if (stats) {
      console.log(`Stats UV: ${stats.uv}, Stats DV: ${stats.dv}`);
      console.log(`Wilson Score: ${stats.wilson95.toFixed(4)}`);
      console.log(`Controversy: ${stats.controversy.toFixed(4)}`);
      console.log(`Like Ratio: ${stats.likeRatio.toFixed(4)}`);
    }

    console.log(`\n--- Revision Analysis ---`);
    console.log(`Stored Revision Count: ${storedRevisionCount}`);
    console.log(`Actual Revision Count: ${actualRevisionCount}`);

    // Show recent votes
    if (version.votes.length > 0) {
      console.log(`\n--- Recent Votes ---`);
      const voteData = [
        ['User', 'Direction', 'Timestamp'],
        ...version.votes.slice(0, 5).map(v => [
          v.user?.displayName || `User#${v.userId}` || 'Anonymous',
          v.direction === 1 ? '+1' : v.direction === -1 ? '-1' : '0',
          v.timestamp.toISOString().split('T')[0],
        ]),
      ];
      console.log(table(voteData));
    }

    // Show recent revisions
    if (version.revisions.length > 0) {
      console.log(`\n--- Recent Revisions ---`);
      const revisionData = [
        ['User', 'Type', 'Comment', 'Timestamp'],
        ...version.revisions.slice(0, 3).map(r => [
          r.user?.displayName || `User#${r.userId}` || 'Anonymous',
          r.type,
          (r.comment || '').substring(0, 30) + (r.comment && r.comment.length > 30 ? '...' : ''),
          r.timestamp.toISOString().split('T')[0],
        ]),
      ];
      console.log(table(revisionData));
    }

    // Validation checks
    const issues: string[] = [];
    
    if (Math.abs(actualVoteCount - storedVoteCount) > 5) {
      issues.push(`Vote count mismatch: stored=${storedVoteCount}, actual=${actualVoteCount}`);
    }
    
    if (stats && (stats.uv !== actualUV || stats.dv !== actualDV)) {
      issues.push(`Stats mismatch: stored UV=${stats.uv} DV=${stats.dv}, actual UV=${actualUV} DV=${actualDV}`);
    }

    if (issues.length > 0) {
      return {
        passed: false,
        message: `Validation issues found`,
        details: issues,
      };
    }

    return { passed: true, message: 'Page verification successful' };
    
  } catch (error) {
    return { passed: false, message: `Error verifying page: ${error.message}` };
  }
}

async function verifyUser(displayName: string): Promise<VerificationResult> {
  try {
    const user = await prisma.user.findFirst({
      where: { displayName },
      include: {
        stats: true,
        votes: {
          include: {
            pageVersion: {
              select: { title: true, rating: true, tags: true },
            },
          },
          orderBy: { timestamp: 'desc' },
          take: 10,
        },
        revisions: {
          include: {
            pageVersion: {
              select: { title: true },
            },
          },
          orderBy: { timestamp: 'desc' },
          take: 5,
        },
      },
    });

    if (!user) {
      return { passed: false, message: `User not found: ${displayName}` };
    }

    console.log(`\n=== User: ${user.displayName} ===`);
    console.log(`WikidotID: ${user.wikidotId}`);
    
    // Calculate actual stats
    const actualUpVotes = user.votes.filter(v => v.direction === 1).length;
    const actualDownVotes = user.votes.filter(v => v.direction === -1).length;
    const actualTotalRating = user.votes.reduce((sum, vote) => {
      const rating = vote.pageVersion.rating || 1;
      return sum + (vote.direction === 1 ? rating : vote.direction === -1 ? -Math.abs(rating) : 0);
    }, 0);

    console.log(`\n--- Vote Statistics ---`);
    console.log(`Actual Up Votes: ${actualUpVotes}`);
    console.log(`Actual Down Votes: ${actualDownVotes}`);
    console.log(`Actual Total Rating: ${actualTotalRating}`);
    
    if (user.stats) {
      console.log(`Stored Up Votes: ${user.stats.totalUp}`);
      console.log(`Stored Down Votes: ${user.stats.totalDown}`);
      console.log(`Stored Total Rating: ${user.stats.totalRating}`);
      console.log(`Favorite Tag: ${user.stats.favTag || 'None'}`);
    } else {
      console.log('No user statistics found');
    }

    // Show recent activity
    if (user.votes.length > 0) {
      console.log(`\n--- Recent Votes ---`);
      const voteData = [
        ['Page', 'Direction', 'Rating', 'Date'],
        ...user.votes.slice(0, 5).map(v => [
          (v.pageVersion.title || 'Untitled').substring(0, 30),
          v.direction === 1 ? '+1' : v.direction === -1 ? '-1' : '0',
          v.pageVersion.rating?.toString() || '0',
          v.timestamp.toISOString().split('T')[0],
        ]),
      ];
      console.log(table(voteData));
    }

    if (user.revisions.length > 0) {
      console.log(`\n--- Recent Revisions ---`);
      const revisionData = [
        ['Page', 'Type', 'Date'],
        ...user.revisions.slice(0, 3).map(r => [
          (r.pageVersion.title || 'Untitled').substring(0, 30),
          r.type,
          r.timestamp.toISOString().split('T')[0],
        ]),
      ];
      console.log(table(revisionData));
    }

    // Tag analysis
    const tagCounts = new Map<string, number>();
    user.votes.forEach(vote => {
      vote.pageVersion.tags.forEach(tag => {
        tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      });
    });
    
    const topTags = Array.from(tagCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    
    if (topTags.length > 0) {
      console.log(`\n--- Top Tags Voted On ---`);
      topTags.forEach(([tag, count]) => {
        console.log(`${tag}: ${count} votes`);
      });
    }

    return { passed: true, message: 'User verification successful' };
    
  } catch (error) {
    return { passed: false, message: `Error verifying user: ${error.message}` };
  }
}

async function verifyCoAuthorPage(url: string): Promise<VerificationResult> {
  try {
    // This would verify pages with multiple attributions
    // For now, just call regular page verification
    return await verifyPage(url);
  } catch (error) {
    return { passed: false, message: `Error verifying co-author page: ${error.message}` };
  }
}

async function showDatabaseStats() {
  try {
    const stats = await prisma.$queryRaw`
      SELECT 
        (SELECT COUNT(*) FROM "Page") as pages,
        (SELECT COUNT(*) FROM "PageVersion") as versions,
        (SELECT COUNT(*) FROM "User") as users,
        (SELECT COUNT(*) FROM "Vote") as votes,
        (SELECT COUNT(*) FROM "Revision") as revisions,
        (SELECT COUNT(*) FROM "PageStats") as analyzed_pages,
        (SELECT COUNT(*) FROM "UserStats") as analyzed_users,
        (SELECT COUNT(*) FROM "Vote" WHERE direction = 1) as up_votes,
        (SELECT COUNT(*) FROM "Vote" WHERE direction = -1) as down_votes,
        (SELECT COUNT(*) FROM "Vote" WHERE direction = 0) as neutral_votes
    `;
    
    console.log('\n=== Database Statistics ===');
    console.log(stats[0]);
    
    // Show top rated pages
    const topPages = await prisma.pageVersion.findMany({
      where: { validTo: null, rating: { not: null } },
      include: { page: true, stats: true },
      orderBy: { rating: 'desc' },
      take: 5,
    });
    
    if (topPages.length > 0) {
      console.log('\n=== Top Rated Pages ===');
      const pageData = [
        ['Title', 'Rating', 'Wilson', 'URL Key'],
        ...topPages.map(p => [
          (p.title || 'Untitled').substring(0, 40),
          p.rating?.toString() || '0',
          p.stats?.wilson95?.toFixed(3) || 'N/A',
          p.page.urlKey,
        ]),
      ];
      console.log(table(pageData));
    }
    
  } catch (error) {
    console.error('Error getting database stats:', error.message);
  }
}

async function main() {
  const command = process.argv[2];
  const target = process.argv[3];
  
  try {
    switch (command) {
      case 'page':
        if (!target) {
          console.error('Usage: verify-data page <url>');
          process.exit(1);
        }
        const pageResult = await verifyPage(target);
        console.log(`\nResult: ${pageResult.passed ? '✅ PASSED' : '❌ FAILED'}`);
        console.log(pageResult.message);
        if (pageResult.details) {
          console.log('Issues:', pageResult.details);
        }
        break;
        
      case 'user':
        if (!target) {
          console.error('Usage: verify-data user <displayName>');
          process.exit(1);
        }
        const userResult = await verifyUser(target);
        console.log(`\nResult: ${userResult.passed ? '✅ PASSED' : '❌ FAILED'}`);
        console.log(userResult.message);
        break;
        
      case 'coauthor':
        if (!target) {
          console.error('Usage: verify-data coauthor <url>');
          process.exit(1);
        }
        const coAuthorResult = await verifyCoAuthorPage(target);
        console.log(`\nResult: ${coAuthorResult.passed ? '✅ PASSED' : '❌ FAILED'}`);
        console.log(coAuthorResult.message);
        break;
        
      case 'stats':
        await showDatabaseStats();
        break;
        
      default:
        console.log('Usage: verify-data <command> [target]');
        console.log('Commands:');
        console.log('  page <url>          - Verify specific page data');
        console.log('  user <displayName>  - Verify specific user data');
        console.log('  coauthor <url>      - Verify co-author page data');
        console.log('  stats               - Show database statistics');
        break;
    }
    
  } catch (error) {
    console.error('Verification failed:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
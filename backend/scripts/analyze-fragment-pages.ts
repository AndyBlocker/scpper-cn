import { PrismaClient } from '@prisma/client';
import { table } from 'table';

/**
 * Fragment Pages Analysis Script
 * Analyzes pages containing "fragment:" in their URL to understand their characteristics
 * and special handling requirements.
 */

async function analyzeFragmentPages() {
  const prisma = new PrismaClient();
  
  console.log('🔍 Analyzing Fragment Pages in SCPPER-CN Database\n');
  
  try {
    // 1. Find all pages with "fragment:" in their URL
    console.log('=== Step 1: Finding Fragment Pages ===');
    
    const fragmentPages = await prisma.$queryRaw<Array<{
      pageId: number;
      url: string;
      urlKey: string;
      title: string | null;
      rating: number | null;
      voteCount: number | null;
      revisionCount: number | null;
      tags: string[];
      isDeleted: boolean;
      validFrom: Date;
      wikidotId: number | null;
      versionId: number;
    }>>`
      SELECT 
        p.id as "pageId",
        p.url,
        p."urlKey",
        pv.title,
        pv.rating,
        pv."voteCount",
        pv."revisionCount",
        pv.tags,
        pv."isDeleted",
        pv."validFrom",
        pv."wikidotId",
        pv.id as "versionId"
      FROM "Page" p
      INNER JOIN "PageVersion" pv ON p.id = pv."pageId"
      WHERE p.url LIKE '%fragment:%'
        AND pv."validTo" IS NULL
      ORDER BY p.url
    `;

    console.log(`Found ${fragmentPages.length} fragment pages\n`);

    if (fragmentPages.length === 0) {
      console.log('No fragment pages found in the database.');
      return;
    }

    // 2. Display basic information about fragment pages
    console.log('=== Step 2: Fragment Pages Overview ===');
    
    const fragmentTable = fragmentPages.slice(0, 20).map(page => [
      page.url.split('/').pop() || 'unknown',
      page.title || 'No Title',
      (page.rating || 0).toString(),
      (page.voteCount || 0).toString(),
      (page.revisionCount || 0).toString(),
      page.tags.join(', ') || 'No tags',
      page.isDeleted ? 'Yes' : 'No'
    ]);

    console.log('Fragment Pages (First 20):');
    console.log(table([
      ['URL Key', 'Title', 'Rating', 'Vote Count', 'Revisions', 'Tags', 'Deleted'],
      ...fragmentTable
    ]));

    if (fragmentPages.length > 20) {
      console.log(`... and ${fragmentPages.length - 20} more fragment pages\n`);
    }

    // 3. Analyze rating patterns
    console.log('=== Step 3: Rating Pattern Analysis ===');
    
    const ratingStats = {
      total: fragmentPages.length,
      withRating: fragmentPages.filter(p => p.rating !== null && p.rating !== 0).length,
      nullRating: fragmentPages.filter(p => p.rating === null).length,
      zeroRating: fragmentPages.filter(p => p.rating === 0).length,
      positiveRating: fragmentPages.filter(p => p.rating && p.rating > 0).length,
      negativeRating: fragmentPages.filter(p => p.rating && p.rating < 0).length,
    };

    console.log('Rating Distribution:');
    console.log(table([
      ['Category', 'Count', 'Percentage'],
      ['Total Fragment Pages', ratingStats.total.toString(), '100%'],
      ['With Non-Zero Rating', ratingStats.withRating.toString(), `${(ratingStats.withRating / ratingStats.total * 100).toFixed(1)}%`],
      ['Null Rating', ratingStats.nullRating.toString(), `${(ratingStats.nullRating / ratingStats.total * 100).toFixed(1)}%`],
      ['Zero Rating', ratingStats.zeroRating.toString(), `${(ratingStats.zeroRating / ratingStats.total * 100).toFixed(1)}%`],
      ['Positive Rating', ratingStats.positiveRating.toString(), `${(ratingStats.positiveRating / ratingStats.total * 100).toFixed(1)}%`],
      ['Negative Rating', ratingStats.negativeRating.toString(), `${(ratingStats.negativeRating / ratingStats.total * 100).toFixed(1)}%`]
    ]));

    // 4. Analyze vote count patterns
    console.log('=== Step 4: Vote Count Pattern Analysis ===');
    
    const voteStats = {
      total: fragmentPages.length,
      withVotes: fragmentPages.filter(p => p.voteCount && p.voteCount > 0).length,
      nullVotes: fragmentPages.filter(p => p.voteCount === null).length,
      zeroVotes: fragmentPages.filter(p => p.voteCount === 0).length,
    };

    console.log('Vote Count Distribution:');
    console.log(table([
      ['Category', 'Count', 'Percentage'],
      ['Total Fragment Pages', voteStats.total.toString(), '100%'],
      ['With Votes', voteStats.withVotes.toString(), `${(voteStats.withVotes / voteStats.total * 100).toFixed(1)}%`],
      ['Null Vote Count', voteStats.nullVotes.toString(), `${(voteStats.nullVotes / voteStats.total * 100).toFixed(1)}%`],
      ['Zero Vote Count', voteStats.zeroVotes.toString(), `${(voteStats.zeroVotes / voteStats.total * 100).toFixed(1)}%`]
    ]));

    // 5. Analyze special handling in DatabaseStore logic
    console.log('=== Step 5: Special Handling Analysis ===');
    
    console.log('Based on the DatabaseStore.ts code analysis:');
    console.log('✅ Fragment pages have special handling for rating changes:');
    console.log('   - Fragment pages with NULL rating are not considered "dirty" if current rating is NULL or 0');
    console.log('   - This prevents unnecessary processing when fragment pages naturally have no rating');
    console.log('✅ Fragment pages have special handling for vote count changes:');
    console.log('   - Fragment pages with NULL voteCount are not considered "dirty" if current voteCount is 0');
    console.log('   - This prevents unnecessary processing when fragment pages naturally have no votes');
    
    // 6. Check for pages that would benefit from special handling
    const specialHandlingBenefit = fragmentPages.filter(p => 
      (p.rating === null || p.rating === 0) && 
      (p.voteCount === null || p.voteCount === 0)
    );
    
    console.log(`\n📊 ${specialHandlingBenefit.length} fragment pages (${(specialHandlingBenefit.length / fragmentPages.length * 100).toFixed(1)}%) benefit from special handling`);
    console.log('   (These pages have null/zero ratings and vote counts, so special logic prevents unnecessary updates)');

    // 7. Analyze fragment page characteristics
    console.log('\n=== Step 6: Fragment Page Characteristics ===');
    
    // Check common patterns in fragment URLs
    const urlPatterns = fragmentPages.reduce((acc, page) => {
      const urlParts = page.url.split('fragment:');
      if (urlParts.length > 1) {
        const fragmentPart = urlParts[1].split('/')[0]; // Get the part right after fragment:
        acc[fragmentPart] = (acc[fragmentPart] || 0) + 1;
      }
      return acc;
    }, {} as Record<string, number>);

    console.log('Common Fragment Types:');
    const sortedPatterns = Object.entries(urlPatterns)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 15);

    console.log(table([
      ['Fragment Type', 'Count'],
      ...sortedPatterns.map(([pattern, count]) => [
        pattern || '(empty)',
        count.toString()
      ])
    ]));

    // 8. Analyze tags
    console.log('=== Step 7: Fragment Page Tags Analysis ===');
    
    const allTags = fragmentPages.flatMap(p => p.tags);
    const tagCounts = allTags.reduce((acc, tag) => {
      acc[tag] = (acc[tag] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    const sortedTags = Object.entries(tagCounts)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 15);

    if (sortedTags.length > 0) {
      console.log('Most Common Tags on Fragment Pages:');
      console.log(table([
        ['Tag', 'Count', 'Percentage of Fragment Pages'],
        ...sortedTags.map(([tag, count]) => [
          tag,
          count.toString(),
          `${(count / fragmentPages.length * 100).toFixed(1)}%`
        ])
      ]));
    } else {
      console.log('No tags found on fragment pages.');
    }

    // 9. Summary and insights
    console.log('=== Step 8: Summary and Insights ===');
    console.log('\n🔍 What are Fragment Pages?');
    console.log('Fragment pages appear to be:');
    console.log('• Pages with URLs containing "fragment:" - likely page components or includes');
    console.log('• Often have null or zero ratings since they are not standalone content');
    console.log('• Often have null or zero vote counts since they are not directly voted on');
    console.log('• Used as building blocks or templates for other pages');

    console.log('\n⚙️ Special Handling Requirements:');
    console.log('• Fragment pages need special handling in dirty queue logic to prevent unnecessary updates');
    console.log('• Rating changes: NULL rating -> NULL/0 rating should not trigger dirty flag');
    console.log('• Vote count changes: NULL voteCount -> 0 voteCount should not trigger dirty flag');
    console.log('• This optimization reduces processing overhead for pages that naturally have no ratings/votes');

    console.log('\n📊 Key Characteristics:');
    console.log(`• Total fragment pages: ${fragmentPages.length}`);
    console.log(`• Pages with actual ratings: ${ratingStats.withRating} (${(ratingStats.withRating / ratingStats.total * 100).toFixed(1)}%)`);
    console.log(`• Pages with actual votes: ${voteStats.withVotes} (${(voteStats.withVotes / voteStats.total * 100).toFixed(1)}%)`);
    console.log(`• Pages benefiting from special handling: ${specialHandlingBenefit.length} (${(specialHandlingBenefit.length / fragmentPages.length * 100).toFixed(1)}%)`);

    // 10. Check for similar patterns with component pages
    console.log('\n=== Step 9: Component Pages Comparison ===');
    
    const componentPages = await prisma.$queryRaw<Array<{
      pageId: number;
      url: string;
      title: string | null;
      rating: number | null;
      voteCount: number | null;
    }>>`
      SELECT 
        p.id as "pageId",
        p.url,
        pv.title,
        pv.rating,
        pv."voteCount"
      FROM "Page" p
      INNER JOIN "PageVersion" pv ON p.id = pv."pageId"
      WHERE p.url LIKE '%component:%'
        AND pv."validTo" IS NULL
      ORDER BY p.url
      LIMIT 10
    `;

    if (componentPages.length > 0) {
      console.log(`Found ${componentPages.length} component pages for comparison:`);
      console.log('Component pages also have similar special handling in the DatabaseStore logic');
      console.log('Both fragment: and component: pages are treated specially to avoid unnecessary dirty flagging');
    } else {
      console.log('No component pages found for comparison.');
    }

    console.log('\n✅ Fragment Page Analysis Complete!');
    
  } catch (error) {
    console.error('❌ Analysis failed:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// Run the analysis if this script is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  analyzeFragmentPages()
    .then(() => {
      console.log('\n🎉 Analysis completed successfully!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('💥 Analysis failed:', error);
      process.exit(1);
    });
}

export { analyzeFragmentPages };
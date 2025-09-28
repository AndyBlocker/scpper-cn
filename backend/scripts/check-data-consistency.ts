import { getPrismaClient, disconnectPrisma } from '../src/utils/db-connection.js';

interface MismatchedPage {
  pageId: number;
  wikidotId: number | null;
  url: string;
  storedCount: number | null;
  actualCount: number;
  difference: number;
}

interface RevisionIssue {
  pageId: number;
  wikidotId: number | null;
  url: string;
  totalRevisions: number;
  createPageRevisions: number;
  revisionNumbers: number[];
}

async function checkDataConsistency() {
  const prisma = getPrismaClient();
  
  try {
    console.log('=== Data Consistency Check ===\n');
    
    // 1. Check vote count mismatches
    console.log('1. Checking vote count mismatches...');
    
    const voteCountMismatches = await prisma.$queryRaw<MismatchedPage[]>`
      WITH actual_counts AS (
        SELECT 
          pv.id as page_version_id,
          pv."pageId",
          pv."wikidotId",
          p."currentUrl" as url,
          pv."voteCount" as stored_count,
          COUNT(v.id) as actual_count
        FROM "PageVersion" pv
        INNER JOIN "Page" p ON pv."pageId" = p.id
        LEFT JOIN "Vote" v ON v."pageVersionId" = pv.id
        WHERE pv."validTo" IS NULL
        GROUP BY pv.id, pv."pageId", pv."wikidotId", p."currentUrl", pv."voteCount"
      )
      SELECT 
        "pageId",
        "wikidotId",
        url,
        stored_count,
        actual_count::int,
        (actual_count - COALESCE(stored_count, 0))::int as difference
      FROM actual_counts
      WHERE COALESCE(stored_count, 0) != actual_count
      ORDER BY ABS(actual_count - COALESCE(stored_count, 0)) DESC
      LIMIT 20;
    `;
    
    if (voteCountMismatches.length > 0) {
      console.log(`\nFound ${voteCountMismatches.length} pages with vote count mismatches (showing top 20):`);
      console.table(voteCountMismatches.map(p => ({
        pageId: p.pageId,
        wikidotId: p.wikidotId,
        url: p.url.substring(p.url.lastIndexOf('/') + 1),
        stored: p.storedCount || 0,
        actual: p.actualCount,
        diff: p.difference
      })));
    } else {
      console.log('✅ No vote count mismatches found');
    }
    
    // 2. Check revision count mismatches
    console.log('\n2. Checking revision count mismatches...');
    
    const revisionCountMismatches = await prisma.$queryRaw<MismatchedPage[]>`
      WITH actual_counts AS (
        SELECT 
          pv.id as page_version_id,
          pv."pageId",
          pv."wikidotId",
          p."currentUrl" as url,
          pv."revisionCount" as stored_count,
          COUNT(r.id) as actual_count
        FROM "PageVersion" pv
        INNER JOIN "Page" p ON pv."pageId" = p.id
        LEFT JOIN "Revision" r ON r."pageVersionId" = pv.id
        WHERE pv."validTo" IS NULL
        GROUP BY pv.id, pv."pageId", pv."wikidotId", p."currentUrl", pv."revisionCount"
      )
      SELECT 
        "pageId",
        "wikidotId",
        url,
        stored_count,
        actual_count::int,
        (actual_count - COALESCE(stored_count, 0))::int as difference
      FROM actual_counts
      WHERE COALESCE(stored_count, 0) != actual_count
      ORDER BY ABS(actual_count - COALESCE(stored_count, 0)) DESC
      LIMIT 20;
    `;
    
    if (revisionCountMismatches.length > 0) {
      console.log(`\nFound ${revisionCountMismatches.length} pages with revision count mismatches (showing top 20):`);
      console.table(revisionCountMismatches.map(p => ({
        pageId: p.pageId,
        url: p.url.substring(p.url.lastIndexOf('/') + 1),
        stored: p.storedCount || 0,
        actual: p.actualCount,
        diff: p.difference
      })));
    } else {
      console.log('✅ No revision count mismatches found');
    }
    
    // 3. Check for pages missing revision 0 (CREATE_PAGE)
    console.log('\n3. Checking for pages with missing revision 0 (CREATE_PAGE)...');
    
    const revision0Issues = await prisma.$queryRaw<RevisionIssue[]>`
      WITH revision_analysis AS (
        SELECT 
          pv."pageId",
          pv."wikidotId",
          p."currentUrl" as url,
          COUNT(r.id) as total_revisions,
          COUNT(CASE WHEN r."wikidotId" = 0 THEN 1 END) as create_page_revisions,
          COUNT(CASE WHEN r.type = 'CREATE_PAGE' THEN 1 END) as create_type_revisions,
          ARRAY_AGG(r."wikidotId" ORDER BY r."wikidotId") as revision_numbers
        FROM "PageVersion" pv
        INNER JOIN "Page" p ON pv."pageId" = p.id
        LEFT JOIN "Revision" r ON r."pageVersionId" = pv.id
        WHERE pv."validTo" IS NULL
        GROUP BY pv."pageId", pv."wikidotId", p."currentUrl"
        HAVING COUNT(r.id) > 0
      )
      SELECT 
        "pageId",
        "wikidotId",
        url,
        total_revisions::int,
        create_page_revisions::int,
        revision_numbers
      FROM revision_analysis
      WHERE create_page_revisions = 0
        AND NOT (0 = ANY(revision_numbers))
      ORDER BY total_revisions DESC
      LIMIT 50;
    `;
    
    if (revision0Issues.length > 0) {
      console.log(`\nFound ${revision0Issues.length} pages potentially missing revision 0 (showing up to 50):`);
      console.table(revision0Issues.slice(0, 10).map(p => ({
        pageId: p.pageId,
        url: p.url.substring(p.url.lastIndexOf('/') + 1),
        totalRevisions: p.totalRevisions,
        firstRevision: p.revisionNumbers && p.revisionNumbers.length > 0 ? p.revisionNumbers[0] : null,
        hasRevision0: p.revisionNumbers ? p.revisionNumbers.includes(0) : false
      })));
      
      // Show a sample of revision numbers for investigation
      console.log('\nSample revision numbers for first 3 pages:');
      revision0Issues.slice(0, 3).forEach(p => {
        console.log(`\n${p.url}:`);
        if (p.revisionNumbers && p.revisionNumbers.length > 0) {
          console.log(`  Revisions: [${p.revisionNumbers.slice(0, 10).join(', ')}${p.revisionNumbers.length > 10 ? '...' : ''}]`);
        } else {
          console.log(`  No revisions found`);
        }
      });
    } else {
      console.log('✅ All pages have revision 0');
    }
    
    // 4. Summary statistics
    console.log('\n4. Summary Statistics:');
    
    const stats = await prisma.$queryRaw<Array<{
      total_pages: bigint;
      pages_with_votes: bigint;
      pages_with_revisions: bigint;
      pages_with_both: bigint;
      pages_with_neither: bigint;
    }>>`
      WITH page_stats AS (
        SELECT 
          pv."pageId",
          COUNT(DISTINCT v.id) as vote_count,
          COUNT(DISTINCT r.id) as revision_count
        FROM "PageVersion" pv
        LEFT JOIN "Vote" v ON v."pageVersionId" = pv.id
        LEFT JOIN "Revision" r ON r."pageVersionId" = pv.id
        WHERE pv."validTo" IS NULL
        GROUP BY pv."pageId"
      )
      SELECT 
        COUNT(*) as total_pages,
        COUNT(CASE WHEN vote_count > 0 THEN 1 END) as pages_with_votes,
        COUNT(CASE WHEN revision_count > 0 THEN 1 END) as pages_with_revisions,
        COUNT(CASE WHEN vote_count > 0 AND revision_count > 0 THEN 1 END) as pages_with_both,
        COUNT(CASE WHEN vote_count = 0 AND revision_count = 0 THEN 1 END) as pages_with_neither
      FROM page_stats;
    `;
    
    if (stats.length > 0) {
      const s = stats[0];
      console.log(`  Total pages: ${s.total_pages}`);
      console.log(`  Pages with votes: ${s.pages_with_votes}`);
      console.log(`  Pages with revisions: ${s.pages_with_revisions}`);
      console.log(`  Pages with both: ${s.pages_with_both}`);
      console.log(`  Pages with neither: ${s.pages_with_neither}`);
    }
    
    // 5. Check for specific revision type issues
    console.log('\n5. Checking revision types distribution...');
    
    const revisionTypes = await prisma.$queryRaw<Array<{
      type: string;
      count: bigint;
    }>>`
      SELECT 
        type,
        COUNT(*) as count
      FROM "Revision"
      GROUP BY type
      ORDER BY count DESC;
    `;
    
    console.log('\nRevision types:');
    console.table(revisionTypes.map(rt => ({
      type: rt.type,
      count: Number(rt.count)
    })));
    
  } catch (error) {
    console.error('Error checking data consistency:', error);
  } finally {
    await disconnectPrisma();
  }
}

checkDataConsistency();
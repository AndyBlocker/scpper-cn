#!/usr/bin/env node
// core/example-usage.js
/**
 * Example usage of the core SCPPER-CN components
 * This demonstrates the 4 core GraphQL query patterns
 */

import { SimpleGraphQLClient } from './client/SimpleGraphQLClient.js';
import { Page } from './entities/Page.js';
import { User } from './entities/User.js';
import { Vote } from './entities/Vote.js';

async function demonstratePhaseABasicScanning() {
  console.log('\n=== Phase A: Basic Page Scanning ===');
  
  const client = new SimpleGraphQLClient();
  
  try {
    // Get first 10 pages for demonstration
    const result = await client.getPhaseAPages({ first: 10 });
    
    console.log(`Found ${result.data.length} pages`);
    console.log(`Has more pages: ${result.pageInfo.hasNextPage}`);
    
    // Show first page details
    if (result.data.length > 0) {
      const firstPage = new Page(result.data[0]);
      console.log(`First page: ${firstPage.title} (${firstPage.rating} rating, ${firstPage.voteCount} votes)`);
    }
    
    return result;
  } catch (error) {
    console.error('Phase A failed:', error.message);
    return null;
  }
}

async function demonstratePhaseBCompleteData() {
  console.log('\n=== Phase B: Complete Page Data ===');
  
  const client = new SimpleGraphQLClient();
  
  try {
    // Get first 5 pages with complete data
    const result = await client.getPhaseBPages({ first: 5 });
    
    console.log(`Retrieved ${result.data.length} complete pages`);
    
    // Show detailed info for first page
    if (result.data.length > 0) {
      const pageData = result.data[0];
      const page = new Page(pageData);
      
      console.log(`Page: ${page.title}`);
      console.log(`- URL: ${pageData.url}`);
      console.log(`- Source length: ${pageData.source ? pageData.source.length : 0} chars`);
      console.log(`- Attributions: ${pageData.attributions ? pageData.attributions.length : 0}`);
      console.log(`- Revisions: ${pageData.revisions ? pageData.revisions.edges.length : 0}`);
      console.log(`- Votes in data: ${pageData.fuzzyVoteRecords ? pageData.fuzzyVoteRecords.edges.length : 0}`);
    }
    
    return result;
  } catch (error) {
    console.error('Phase B failed:', error.message);
    return null;
  }
}

async function demonstratePhaseCVoteProcessing(pageUrl) {
  console.log(`\n=== Phase C: Vote Processing for ${pageUrl} ===`);
  
  const client = new SimpleGraphQLClient();
  
  try {
    // Get votes for specific page
    const result = await client.getPhaseCVotes(pageUrl, { first: 50 });
    
    console.log(`Retrieved ${result.data.length} votes`);
    console.log(`Has more votes: ${result.pageInfo ? result.pageInfo.hasNextPage : false}`);
    
    if (result.data.length > 0) {
      // Analyze vote distribution
      const upvotes = result.data.filter(v => v.direction === 1).length;
      const downvotes = result.data.filter(v => v.direction === -1).length;
      const neutrals = result.data.filter(v => v.direction === 0).length;
      
      console.log(`Vote distribution: +${upvotes}, -${downvotes}, 0${neutrals}`);
      console.log(`Calculated rating: ${upvotes - downvotes}`);
      
      // Show first few votes with detailed user info
      console.log('Sample votes:');
      result.data.slice(0, 3).forEach((vote, i) => {
        const userName = vote.user?.displayName || `ID:${vote.userWikidotId}`;
        console.log(`  ${i + 1}. User ${userName} (${vote.userWikidotId}): ${vote.direction > 0 ? '+' : vote.direction < 0 ? '-' : '0'}${Math.abs(vote.direction)} at ${vote.timestamp}`);
        if (vote.user) {
          console.log(`      └─ User details: displayName="${vote.user.displayName}", wikidotId="${vote.user.wikidotId}"`);
        }
      });
    }
    
    return result;
  } catch (error) {
    console.error('Phase C failed:', error.message);
    return null;
  }
}

async function demonstrateTotalCount() {
  console.log('\n=== Total Count Query ===');
  
  const client = new SimpleGraphQLClient();
  
  try {
    const result = await client.getTotalCount();
    console.log(`Has pages in database: ${result.hasPages}`);
    
    return result;
  } catch (error) {
    console.error('Total count failed:', error.message);
    return null;
  }
}

async function demonstrateUserQueries() {
  console.log('\n=== User Queries ===');
  
  const client = new SimpleGraphQLClient();
  
  try {
    // Try to get a user by name (this might not work without knowing valid names)
    // This is just to show the API structure
    console.log('User query methods available:');
    console.log('- getUserByName(displayName)');
    console.log('- getUserById(wikidotId)');
    
    return true;
  } catch (error) {
    console.error('User queries demonstration failed:', error.message);
    return null;
  }
}

async function main() {
  console.log('SCPPER-CN Core Components Demonstration');
  console.log('======================================');
  
  // Check connectivity
  const client = new SimpleGraphQLClient();
  const isHealthy = await client.isHealthy();
  
  if (!isHealthy) {
    console.error('❌ Cannot connect to GraphQL API. Please check your network and proxy settings.');
    process.exit(1);
  }
  
  console.log('✅ Successfully connected to CROM GraphQL API');
  
  // Demonstrate the 4 core query patterns
  const phaseAResult = await demonstratePhaseABasicScanning();
  const phaseBResult = await demonstratePhaseBCompleteData();
  
  // Use first page from Phase A for Phase C demonstration
  if (phaseAResult && phaseAResult.data.length > 0) {
    await demonstratePhaseCVoteProcessing(phaseAResult.data[0].url);
  }
  
  await demonstrateTotalCount();
  await demonstrateUserQueries();
  
  console.log('\n=== Core Components Ready ===');
  console.log('You can now implement your sync logic using:');
  console.log('1. Page, User, Vote entities from ./entities/');
  console.log('2. SimpleGraphQLClient for API calls');
  console.log('3. CoreQueries for GraphQL patterns');
  console.log('4. The 4 main query methods:');
  console.log('   - getPhaseAPages() for basic scanning');
  console.log('   - getPhaseBPages() for complete data');
  console.log('   - getPhaseCVotes() for vote processing');
  console.log('   - getTotalCount() for progress tracking');
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
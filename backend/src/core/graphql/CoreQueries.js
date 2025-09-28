// core/graphql/CoreQueries.js
/**
 * Core GraphQL Query Patterns for SCPPER-CN
 * Contains the 4 essential query types: phaseA, phaseB, phaseC, and totalCount
 */
export class CoreQueries {
  constructor() {
    this.fragments = new Map();
    this.queries = new Map();
    
    this.initializeFragments();
    this.initializeQueries();
  }

  initializeFragments() {
    // Basic page fragment for Phase A (lightweight scanning)
    this.fragments.set('WikidotPageBasic', `
      fragment WikidotPageBasic on WikidotPage {
        url
        wikidotId
        title
        rating
        voteCount
        category
        tags
        createdAt
        revisionCount
        commentCount
        isHidden
        isUserPage
        thumbnailUrl
        createdBy {
          ... on WikidotUser {
            displayName
            wikidotId
          }
        }
        parent {
          url
        }
        attributions {
          type
          user {
            displayName
            ... on UserWikidotNameReference {
              wikidotUser { displayName wikidotId }
            }
          }
          date
          order
        }
      }
    `);

    // Complete page fragment for Phase B (detailed data)
    this.fragments.set('WikidotPageComplete', `
      fragment WikidotPageComplete on WikidotPage {
        ...WikidotPageBasic
        source
        textContent
        alternateTitles {
          title
          source
        }
        children{
          url
        }
        attributions {
          type
          user {
            displayName
            ... on UserWikidotNameReference {
              wikidotUser {
                displayName
                wikidotId
              }
            }
          }
          date
          order
        }
      }
    `);

    // Vote record fragment for Phase C (vote processing)
    this.fragments.set('VoteRecordBasic', `
      fragment VoteRecordBasic on WikidotVoteRecord {
        userWikidotId
        direction
        timestamp
        anonKey
        user {
          ... on WikidotUser {
            displayName
            wikidotId
          }
        }
      }
    `);

    // User fragment for user queries
    this.fragments.set('WikidotUserBasic', `
      fragment WikidotUserBasic on WikidotUser {
        id
        displayName
        wikidotId
        unixName
        statistics {
          pageCount
          totalRating
          meanRating
        }
      }
    `);
  }

  initializeQueries() {
    // Phase A: Basic page scanning (lightweight, for getting page lists)
    this.queries.set('phaseA', `
      query GetPagesBasic($filter: PageQueryFilter, $first: Int, $after: ID) {
        pages(filter: $filter, first: $first, after: $after) {
          edges {
            node {
              url
              ... on WikidotPage {
                ...WikidotPageBasic
              }
            }
            cursor
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    `);

    // Phase B: Complete page data (detailed information including attributions, revisions)
    this.queries.set('phaseB', `
      query GetPagesComplete($filter: PageQueryFilter, $first: Int, $after: ID) {
        pages(filter: $filter, first: $first, after: $after) {
          edges {
            node {
              url
              ... on WikidotPage {
                ...WikidotPageComplete
                revisions(first: 20) {
                  edges {
                    node {
                      wikidotId
                      timestamp
                      type
                      user {
                        ... on WikidotUser {
                          displayName
                          wikidotId
                        }
                      }
                      comment
                    }
                  }
                }
                fuzzyVoteRecords(first: 50) {
                  edges {
                    node {
                      ...VoteRecordBasic
                    }
                  }
                }
              }
            }
            cursor
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    `);

    // Phase C: Vote records (for specific pages, high-volume vote processing)
    this.queries.set('phaseC', `
      query GetPageVotes($url: URL!, $first: Int, $after: ID) {
        wikidotPage(url: $url) {
          url
          fuzzyVoteRecords(first: $first, after: $after) {
            edges {
              node {
                ...VoteRecordBasic
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }
    `);

    // Total Count: Get total page count for progress tracking
    this.queries.set('totalCount', `
      query GetTotalPageCount($filter: PageQueryFilter) {
        pages(filter: $filter, first: 1) {
          pageInfo {
            hasNextPage
          }
        }
      }
    `);

    // Single page query (for individual page fetching)
    this.queries.set('singlePage', `
      query GetPageByUrl($url: URL!) {
        wikidotPage(url: $url) {
          ...WikidotPageComplete
        }
      }
    `);

    // User queries
    this.queries.set('userByName', `
      query GetUserByName($displayName: String!) {
        wikidotUser(displayName: $displayName) {
          ...WikidotUserBasic
        }
      }
    `);

    this.queries.set('userById', `
      query GetUserById($wikidotId: String!) {
        wikidotUser(wikidotId: $wikidotId) {
          ...WikidotUserBasic
        }
      }
    `);
  }

  /**
   * Build a query with required fragments
   */
  buildQuery(queryName, variables = {}) {
    const query = this.queries.get(queryName);
    if (!query) {
      throw new Error(`Query '${queryName}' not found. Available queries: ${this.getAvailableQueries().join(', ')}`);
    }

    const fragments = this.getRequiredFragments(query);
    const fullQuery = fragments.length > 0 
      ? `${fragments.join('\n\n')}\n\n${query}`
      : query;

    return {
      query: fullQuery,
      variables,
      queryName
    };
  }

  /**
   * Get required fragments for a query
   */
  getRequiredFragments(query) {
    const fragmentNames = new Set();
    const fragments = [];
    
    // Recursively collect all fragment dependencies
    const collectFragmentNames = (text) => {
      const fragmentPattern = /\.\.\.(\w+)/g;
      let match;
      
      while ((match = fragmentPattern.exec(text)) !== null) {
        const fragmentName = match[1];
        if (!fragmentNames.has(fragmentName)) {
          fragmentNames.add(fragmentName);
          
          // Check if this fragment depends on other fragments
          const fragment = this.fragments.get(fragmentName);
          if (fragment) {
            collectFragmentNames(fragment);
          }
        }
      }
    };
    
    // Start fragment collection from the query
    collectFragmentNames(query);
    
    // Add fragments in dependency order
    const addedFragments = new Set();
    const addFragment = (fragmentName) => {
      if (addedFragments.has(fragmentName)) return;
      
      const fragment = this.fragments.get(fragmentName);
      if (fragment) {
        // First add dependencies
        const dependencyPattern = /\.\.\.(\w+)/g;
        let match;
        
        while ((match = dependencyPattern.exec(fragment)) !== null) {
          const depName = match[1];
          if (!addedFragments.has(depName)) {
            addFragment(depName);
          }
        }
        
        // Then add this fragment
        fragments.push(fragment);
        addedFragments.add(fragmentName);
      }
    };
    
    // Add all collected fragments
    fragmentNames.forEach(fragmentName => addFragment(fragmentName));
    
    return fragments;
  }

  /**
   * Helper to build SCP-CN filter
   */
  buildScpCnFilter() {
    return {
      onWikidotPage: {
        url: { startsWith: "http://scp-wiki-cn.wikidot.com" }
      }
    };
  }

  /**
   * Helper to build variables for phase A (basic pages)
   */
  buildPhaseAVariables(options = {}) {
    return {
      filter: options.filter || this.buildScpCnFilter(),
      first: options.first || 100,
      after: options.after || null
    };
  }

  /**
   * Helper to build variables for phase B (complete pages)
   */
  buildPhaseBVariables(options = {}) {
    return {
      filter: options.filter || this.buildScpCnFilter(),
      first: options.first || 10, // Very small batch for complete data due to complexity
      after: options.after || null
    };
  }

  /**
   * Helper to build variables for phase C (votes)
   */
  buildPhaseCVariables(pageUrl, options = {}) {
    return {
      url: pageUrl,
      first: options.first || 99,
      after: options.after || null
    };
  }

  /**
   * Get list of available queries
   */
  getAvailableQueries() {
    return Array.from(this.queries.keys());
  }

  /**
   * Get list of available fragments
   */
  getAvailableFragments() {
    return Array.from(this.fragments.keys());
  }
  
}

export function getFragmentSource(fragmentName, coreQueriesInstance = null) {
  const cq = coreQueriesInstance ?? new CoreQueries();
  return cq.fragments.get(fragmentName);
}

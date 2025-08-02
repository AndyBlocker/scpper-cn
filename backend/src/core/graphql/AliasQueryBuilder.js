// src/core/graphql/AliasQueryBuilder.js
import { CoreQueries } from './CoreQueries.js';
const cq = new CoreQueries();
const MAX_FIRST = 100;

export function buildAliasQuery(pages, options = {}) {
  const queries = [];
  const variables = {};
  
  // Phase B uses conservative limits to match actual processing
  const revisionLimit = options.revisionLimit ?? MAX_FIRST;
  const voteLimit = options.voteLimit ?? MAX_FIRST;

  pages.forEach((page, idx) => {
    const alias = `p${idx}`;
    const varUrl = `url${idx}`;
    variables[varUrl] = page.url || page.wikidotInfo?.url;

    // 根据实际数量和限制动态设置first参数，避免浪费
    const revFirst = Math.min(page.revisionCount ?? 0, revisionLimit);
    const voteFirst = Math.min(page.voteCount ?? 0, voteLimit);

    // 只有在需要的时候才包含revisions和votes查询
    const revPart = revFirst > 0 ? 
      `revisions(first: ${revFirst}) { 
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
      }` : '';
    
    const votePart = voteFirst > 0 ? 
      `fuzzyVoteRecords(first: ${voteFirst}) { 
        edges { 
          node { 
            direction 
            timestamp 
            userWikidotId
            user {
              ... on WikidotUser {
                displayName
                wikidotId
              }
            }
          } 
        } 
      }` : '';

    queries.push(`
      ${alias}: wikidotPage(url: $${varUrl}) {
        ...WikidotPageComplete
        ${revPart}
        ${votePart}
      }`);
  });

  const fragments = cq.getRequiredFragments(queries.join('\n'));

  const gql = `
    ${fragments.join('\n')}
    query AliasBatch(${Object.keys(variables).map(v => `$${v}: URL!`).join(', ')}) {
      ${queries.join('\n')}
    }
  `;
  return { query: gql, variables };
}

# SCPPER-CN Backend - Core Components

This is the minimal core version of the SCPPER-CN backend, containing only the essential classes and GraphQL query patterns.

## What's Included

### Core Entities
- **Page.js** - Basic page entity with validation
- **User.js** - Basic user entity  
- **Vote.js** - Basic vote entity

### GraphQL Components
- **CoreQueries.js** - The 4 essential GraphQL query patterns
- **SimpleGraphQLClient.js** - Basic GraphQL client with retry logic

### The 4 Core Query Patterns

1. **Phase A** (`phaseA`) - Basic page scanning (lightweight)
   - Used for getting lists of pages with minimal data
   - ~1-5 complexity points per page

2. **Phase B** (`phaseB`) - Complete page data
   - Used for getting detailed page information including revisions, votes, attributions
   - ~200-500 complexity points per page

3. **Phase C** (`phaseC`) - Vote processing  
   - Used for getting vote records for specific pages
   - ~1 complexity point per vote

4. **Total Count** (`totalCount`) - Progress tracking
   - Used for getting total counts for progress estimation

## Quick Start

```bash
# Install dependencies
npm install

# Run the example to test connectivity
npm run example
```

## Usage Example

```javascript
import { SimpleGraphQLClient } from './core/graphql/SimpleGraphQLClient.js';
import { Page } from './core/entities/Page.js';

const client = new SimpleGraphQLClient();

// Phase A: Get basic pages
const result = await client.getPhaseAPages({ first: 100 });
console.log(`Found ${result.data.length} pages`);

// Phase B: Get complete page data  
const detailedResult = await client.getPhaseBPages({ first: 10 });
console.log(`Retrieved detailed data for ${detailedResult.data.length} pages`);

// Phase C: Get votes for a specific page
const votes = await client.getPhaseCVotes(pageUrl, { first: 100 });
console.log(`Found ${votes.data.length} votes`);
```

## GraphQL API Information

- **Endpoint**: `https://apiv2.crom.avn.sh/graphql`
- **Rate Limit**: 300,000 points per 5-minute window
- **Complexity Limit**: 1000 complexity per request
- **Target Site**: `http://scp-wiki-cn.wikidot.com`

## Project Structure

```
backend/
├── core/
│   ├── entities/
│   │   ├── Page.js          # Page entity
│   │   ├── User.js          # User entity  
│   │   └── Vote.js          # Vote entity
│   ├── graphql/
│   │   ├── CoreQueries.js   # GraphQL query patterns
│   │   └── SimpleGraphQLClient.js # GraphQL client
│   └── example-usage.js     # Usage demonstration
├── package.json
├── prisma/                  # Database schema (kept for reference)
└── README.md
```

## Implementing Your Own Sync Logic

You can now build your own synchronization strategy using these core components:

1. Use `getPhaseAPages()` to scan all pages
2. Use `getPhaseBPages()` to get detailed page information  
3. Use `getPhaseCVotes()` to get comprehensive vote data
4. Use the entity classes to validate and structure data
5. Implement your own database layer, checkpointing, and business logic

## Rate Limiting

The `SimpleGraphQLClient` includes basic rate limit handling:
- Automatic retry on 429 errors
- Respects `retry-after` headers
- Simple exponential backoff

For production use, you may want to implement more sophisticated rate limiting and checkpoint systems.

## Next Steps

This core provides the foundation. You can now implement:
- Database persistence layer
- Checkpoint/resume functionality  
- Progress tracking and monitoring
- Data analysis and export features
- Web interface or API endpoints
- Advanced rate limiting and optimization

The old complex implementation has been removed to give you a clean slate for building exactly what you need.
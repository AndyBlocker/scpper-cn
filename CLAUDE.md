# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview
SCPPER-CN is a data synchronization and analysis system for SCP Wiki CN. It fetches data from the SCP Wiki CN GraphQL API, stores it in a PostgreSQL database, and provides various analysis and search capabilities.

## System Architecture

### Three-Phase Sync Process
- **Phase A**: Complete page scanning → PageMetaStaging + DirtyPage queue
- **Phase B**: Targeted content collection for changed pages
- **Phase C**: Complex processing with concurrency control for heavy pages

### Data Flow
1. GraphQL API → PageMetaStaging (temporary staging)
2. Change detection → DirtyPage queue
3. Batch processing → Core tables (Page, PageVersion, etc.)
4. Incremental analysis → Analytics tables (PageStats, UserStats, etc.)
5. Watermark system tracks processing state for incremental updates

## Important Development Guidelines

### Script Management Policy
1. **One-time scripts**: Place in `backend/cache/` directory
   - This directory is gitignored
   - Use for temporary scripts, data fixes, or one-off migrations
   - Example: `backend/cache/fix-user-data.ts`

2. **Reusable scripts**: Ask user before saving
   - If the script might be used frequently, ask: "This functionality seems useful for repeated use. Would you like me to save it to the scripts folder and add an npm run command?"
   - Save to `backend/scripts/` if confirmed
   - Add corresponding npm script to `backend/package.json`

### Linting and Type Checking
- **ALWAYS** run linting and type checking after code changes:
  - `npm run lint` - Check for linting errors
  - `npm run typecheck` - Check for TypeScript errors
- If commands are not found, ask user for the correct commands

## Complete Commands Reference

### Sync Commands
- `npm run sync` - Incremental sync (default)
- `npm run sync:full` - Full sync with --full flag
- `npm run sync:test` - Test mode (first batch only)
- `npm run sync:phase-a` - Run Phase A only
- `npm run sync:phase-b` - Run Phase B only
- `npm run sync:phase-c` - Run Phase C only

### Analysis Commands
- `npm run analyze` - Run analysis after sync
- `npm run analyze:incremental` - Incremental analysis only
- `npm run analyze:full` - Force full analysis
- `npm run analyze:init-history` - Initialize historical daily aggregates
- `npm run analyze:complete-init` - Complete initialization with full history

### Utility Commands
- `npm run query` - Interactive CLI query tool
- `npm run db:clear` - Clear all data (destructive)
- `npx prisma migrate dev` - Run database migrations
- `npx prisma generate` - Generate Prisma client

## Database Setup

### Required PostgreSQL Extensions
- `pg_trgm` - Trigram matching for text search
- `pgroonga` - Full-text search with Chinese support
- `vector` - Vector similarity for embeddings
- `zhparser` - Chinese text parsing

### Environment Variables
- `DATABASE_URL` - PostgreSQL connection string
- `TARGET_SITE_URL` - SCP Wiki CN base URL (default: http://scp-wiki-cn.wikidot.com)

## Project Structure
```
backend/
├── src/
│   ├── cli/           # CLI commands (sync, query)
│   ├── core/          # Core processors and stores
│   │   ├── processors/  # Phase A/B/C processors
│   │   └── store/       # Modular data stores
│   ├── jobs/          # Background analysis jobs
│   ├── services/      # Service layer (search, embeddings)
│   └── utils/         # Utilities
├── scripts/           # Reusable scripts (tracked in git)
├── cache/            # One-time scripts (gitignored)
└── prisma/           # Database schema and migrations
```

## Key Technologies
- **TypeScript** - Primary language
- **Prisma ORM** - Database access and migrations
- **PostgreSQL** - Database with Chinese search extensions
- **GraphQL** - Custom client for SCP Wiki CN API with rate limiting
- **Store Architecture** - Modular stores (PageStore, PageVersionStore, VoteRevisionStore, DirtyQueueStore)
- **Watermark System** - Tracks incremental processing state

## Common Tasks

### Adding a new analysis job
1. Create the job in `backend/src/jobs/`
2. Add it to `IncrementalAnalyzeJob.ts`
3. Update the task list in the analyze method

### Debugging sync issues
1. Check `DirtyPage` table for processing queue
2. Review `PageMetaStaging` for incoming data
3. Use test mode to debug first batch: `npm run sync:test`
4. Check watermark tables for processing state

### Performance Considerations
- Phase A: Scans all pages, builds dirty queue
- Phase B: Batch processes pages with content
- Phase C: Handles complex pages with many revisions/votes
- Use concurrency control in Phase C for rate limiting
- Incremental analysis uses watermarks to avoid reprocessing

## Missing Features Tracking
See `backend/MISSING_DATA_AND_FEATURES.md` for a comprehensive list of unimplemented features and data gaps, including:
- User table incomplete fields
- SearchIndex embeddings not integrated
- UserSearchIndex completely unimplemented
- Several behavior analysis tables not in use
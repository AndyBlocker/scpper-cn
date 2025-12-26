#!/usr/bin/env node

import { Prisma } from '@prisma/client'
import { getPrismaClient, disconnectPrisma } from '../src/utils/db-connection.js'

type CliOptions = {
  wikidotId: number | null
  includeDeleted: boolean
  limit: number
  offset: number
  json: boolean
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    wikidotId: null,
    includeDeleted: true,
    limit: 200,
    offset: 0,
    json: false
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--wikidot-id' || a === '--user' || a === '-u') {
      const v = argv[++i]
      if (!v) throw new Error(`${a} requires a value`)
      const n = Number.parseInt(v, 10)
      if (!Number.isFinite(n)) throw new Error(`Invalid wikidot id: ${v}`)
      opts.wikidotId = n
    } else if (a === '--include-deleted') {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${a} requires true|false`)
      opts.includeDeleted = String(v).toLowerCase() === 'true'
    } else if (a === '--limit' || a === '-l') {
      const v = argv[++i]
      if (!v) throw new Error(`${a} requires a value`)
      const n = Number.parseInt(v, 10)
      if (!Number.isFinite(n) || n < 1) throw new Error(`Invalid limit: ${v}`)
      opts.limit = Math.min(n, 1000)
    } else if (a === '--offset' || a === '-o') {
      const v = argv[++i]
      if (!v) throw new Error(`${a} requires a value`)
      const n = Number.parseInt(v, 10)
      if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid offset: ${v}`)
      opts.offset = n
    } else if (a === '--json') {
      opts.json = true
    } else if (a === '--help' || a === '-h') {
      printHelpAndExit()
    }
  }
  return opts
}

function printHelpAndExit(code = 0) {
  console.log(`Find user downvotes (dedup by page)

Usage:
  node --import tsx/esm scripts/find-user-downvotes.ts --wikidot-id 5166393 [--include-deleted true] [--limit 200] [--offset 0] [--json]

Notes:
  - Dedup by page: if a user voted multiple page versions, only the latest vote per page is kept.
  - include-deleted=true includes pages currently deleted (recommended to surface all downvotes).
`)
  process.exit(code)
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (!opts.wikidotId) {
    printHelpAndExit(1)
  }

  const prisma = getPrismaClient()
  try {
    const userRow = await prisma.user.findFirst({
      where: { wikidotId: opts.wikidotId },
      select: { id: true, displayName: true }
    })
    if (!userRow) {
      console.error(`User not found for wikidotId=${opts.wikidotId}`)
      process.exit(2)
    }

    type VoteRow = {
      timestamp: Date
      direction: number
      pageWikidotId: number | null
      pageTitle: string | null
      pageAlternateTitle: string | null
      pageUrl: string | null
      pageDeleted: boolean | null
    }

    const rows = await prisma.$queryRaw<VoteRow[]>(Prisma.sql`
      WITH target_user AS (
        SELECT id FROM "User" WHERE "wikidotId" = ${opts.wikidotId}
      ),
      user_votes AS (
        SELECT v.id, v."pageVersionId", v.timestamp, v.direction, v."userId"
        FROM "Vote" v
        JOIN target_user tu ON v."userId" = tu.id
      ),
      votes_by_page AS (
        SELECT uv.id, uv."userId", pv."pageId", uv.timestamp, uv.direction,
               ROW_NUMBER() OVER (
                 PARTITION BY pv."pageId", uv."userId"
                 ORDER BY uv.timestamp DESC, uv.id DESC
               ) AS rn
        FROM user_votes uv
        JOIN "PageVersion" pv ON pv.id = uv."pageVersionId"
      ),
      latest_per_page AS (
        SELECT vbp."pageId", vbp.timestamp, vbp.direction
        FROM votes_by_page vbp
        WHERE vbp.rn = 1
      )
      SELECT 
        lpp.timestamp,
        lpp.direction,
        live_pv."wikidotId" as "pageWikidotId",
        live_pv.title as "pageTitle",
        live_pv."alternateTitle" as "pageAlternateTitle",
        p."currentUrl" as "pageUrl",
        live_pv."isDeleted" as "pageDeleted"
      FROM latest_per_page lpp
      JOIN "Page" p ON p.id = lpp."pageId"
      LEFT JOIN LATERAL (
        SELECT pv2.*
        FROM "PageVersion" pv2
        WHERE pv2."pageId" = lpp."pageId"
        ORDER BY 
          (pv2."validTo" IS NULL) DESC,
          (NOT pv2."isDeleted") DESC,
          pv2."validFrom" DESC NULLS LAST,
          pv2.id DESC
        LIMIT 1
      ) live_pv ON TRUE
      WHERE lpp.direction < 0
        AND (${opts.includeDeleted}::boolean = true OR COALESCE(live_pv."isDeleted", false) = false)
      ORDER BY lpp.timestamp DESC
      LIMIT ${opts.limit}::int OFFSET ${opts.offset}::int
    `)

    if (opts.json) {
      console.log(JSON.stringify({
        wikidotId: opts.wikidotId,
        includeDeleted: opts.includeDeleted,
        count: rows.length,
        items: rows
      }, null, 2))
    } else {
      if (rows.length === 0) {
        console.log('No downvotes found (after dedup by page).')
      } else {
        console.log(`Downvotes for user #${opts.wikidotId} (dedup by page) — showing ${rows.length} items:`)
        for (const r of rows) {
          const title = r.pageTitle || r.pageAlternateTitle || ''
          const ts = new Date(r.timestamp).toISOString()
          const del = r.pageDeleted ? ' [DELETED]' : ''
          console.log(`- ${r.pageWikidotId ?? '?'} | ${title}${del} | ${r.pageUrl ?? ''} | ${ts}`)
        }
      }
    }
  } finally {
    await disconnectPrisma()
  }
}

main().catch((err) => {
  console.error('Failed to fetch user downvotes:', err)
  process.exit(1)
})


import { getPrismaClient } from '../src/utils/db-connection.js'
const prisma = getPrismaClient()

// Get all current-version attributions for xiasheng01
const attrs = await prisma.attribution.findMany({
  where: { userId: 14348, type: { in: ['AUTHOR', 'SUBMITTER'] } },
  select: { pageVerId: true, type: true }
})

// Check which ones are current
let currentCount = 0
const seenPages = new Set()
for (const a of attrs) {
  const pv = await prisma.pageVersion.findUnique({
    where: { id: a.pageVerId },
    select: { id: true, title: true, validTo: true, isDeleted: true, pageId: true }
  })
  if (pv && !pv.validTo && !pv.isDeleted) {
    currentCount++
    seenPages.add(pv.pageId)
  }
}
console.log(`Current-version attributions: ${currentCount}`)
console.log(`Unique pages (by pageId): ${seenPages.size}`)

// Now check: is this user in the generated JSON?
const fs = await import('fs/promises')
const fp = JSON.parse(await fs.readFile('/home/andyblocker/scpper-cn/bff/data/text-analysis/author-fingerprints.json', 'utf8'))
const found = fp.find((a: any) => a.displayName === 'xiasheng01')
console.log(`\nIn fingerprints JSON: ${found ? 'YES' : 'NO'}`)
console.log(`Total authors in JSON: ${fp.length}`)

// Check how many authors have exactly 3-24 pages
const pageCounts = fp.map((a: any) => a.pageCount)
const below25 = pageCounts.filter((c: number) => c < 25)
console.log(`Authors with <25 pages: ${below25.length}/${fp.length}`)
console.log(`Min pageCount in JSON: ${Math.min(...pageCounts)}`)

await prisma.$disconnect()

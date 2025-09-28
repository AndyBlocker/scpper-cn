#!/usr/bin/env node
import { getPrismaClient, disconnectPrisma } from '../src/utils/db-connection.js';

type InteractionRow = {
  userId: number;
  displayName?: string | null;
  wikidotId?: number | null;
  uv: number;
  dv: number;
  total: number;
  lastVoteAt: Date | null;
};

type TagPrefRow = {
  tag: string;
  uv: number;
  dv: number;
  total: number;
  lastVoteAt: Date | null;
};

function getArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.find(a => a.startsWith(prefix));
  if (found) return found.slice(prefix.length);
  const idx = process.argv.findIndex(a => a === `--${name}`);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return undefined;
}

async function main() {
  const prisma = getPrismaClient();
  try {
    const userIdArg = getArg('userId');
    const wikidotIdArg = getArg('wikidotId');
    if (!userIdArg && !wikidotIdArg) {
      console.error('Usage: verify-user-interactions --userId <id> | --wikidotId <id>');
      process.exitCode = 2;
      return;
    }

    // Resolve user
    const user = await (async () => {
      if (userIdArg) {
        const id = Number(userIdArg);
        const u = await prisma.user.findUnique({ where: { id } });
        if (!u) throw new Error(`User not found by id=${id}`);
        return u;
      } else {
        const wid = Number(wikidotIdArg);
        const u = await prisma.user.findFirst({ where: { wikidotId: wid } });
        if (!u) throw new Error(`User not found by wikidotId=${wid}`);
        return u;
      }
    })();

    console.log(`Verifying interactions for user: id=${user.id}, wikidotId=${user.wikidotId}, displayName=${user.displayName}`);

    // 1) Recompute outgoing interactions: me -> others
    const outgoing = await prisma.$queryRaw<Array<InteractionRow>>`
      WITH vote_interactions AS (
        SELECT 
          v."userId" as from_user_id,
          a."userId" as to_user_id,
          v.direction,
          v.timestamp
        FROM "Vote" v
        JOIN "PageVersion" pv ON v."pageVersionId" = pv.id
        JOIN "Attribution" a ON a."pageVerId" = pv.id
        WHERE v."userId" = ${user.id}
          AND a."userId" IS NOT NULL
          AND v."userId" != a."userId"
          AND v.direction != 0
          AND a.type = 'AUTHOR'
          AND pv."validTo" IS NULL
          AND pv."isDeleted" = false
      )
      SELECT 
        to_user_id AS "userId",
        COUNT(*) FILTER (WHERE direction = 1) AS uv,
        COUNT(*) FILTER (WHERE direction = -1) AS dv,
        COUNT(*) AS total,
        MAX(timestamp) AS "lastVoteAt"
      FROM vote_interactions
      GROUP BY to_user_id
      ORDER BY total DESC, "lastVoteAt" DESC NULLS LAST
    `;

    // 2) Recompute incoming interactions: others -> me
    const incoming = await prisma.$queryRaw<Array<InteractionRow>>`
      WITH vote_interactions AS (
        SELECT 
          v."userId" as from_user_id,
          a."userId" as to_user_id,
          v.direction,
          v.timestamp
        FROM "Vote" v
        JOIN "PageVersion" pv ON v."pageVersionId" = pv.id
        JOIN "Attribution" a ON a."pageVerId" = pv.id
        WHERE a."userId" = ${user.id}
          AND v."userId" IS NOT NULL
          AND v."userId" != a."userId"
          AND v.direction != 0
          AND a.type = 'AUTHOR'
          AND pv."validTo" IS NULL
          AND pv."isDeleted" = false
      )
      SELECT 
        from_user_id AS "userId",
        COUNT(*) FILTER (WHERE direction = 1) AS uv,
        COUNT(*) FILTER (WHERE direction = -1) AS dv,
        COUNT(*) AS total,
        MAX(timestamp) AS "lastVoteAt"
      FROM vote_interactions
      GROUP BY from_user_id
      ORDER BY total DESC, "lastVoteAt" DESC NULLS LAST
    `;

    // 3) Load stored aggregation for interactions
    const storedOutgoing = await prisma.userVoteInteraction.findMany({ where: { fromUserId: user.id } });
    const storedIncoming = await prisma.userVoteInteraction.findMany({ where: { toUserId: user.id } });

    function toMap<T extends { userId: number; uv: number; dv: number; total: number; lastVoteAt: Date | null }>(rows: T[]) {
      const m = new Map<number, T>();
      rows.forEach(r => m.set(Number(r.userId), r));
      return m;
    }

    const outMap = toMap(outgoing.map(r => ({ ...r, uv: Number(r.uv), dv: Number(r.dv), total: Number(r.total) })));
    const inMap = toMap(incoming.map(r => ({ ...r, uv: Number(r.uv), dv: Number(r.dv), total: Number(r.total) })));

    const storedOutMap = new Map<number, { uv: number; dv: number; total: number; lastVoteAt: Date | null }>();
    storedOutgoing.forEach(r => storedOutMap.set(r.toUserId, { uv: r.upvoteCount, dv: r.downvoteCount, total: r.totalVotes, lastVoteAt: r.lastVoteAt }));

    const storedInMap = new Map<number, { uv: number; dv: number; total: number; lastVoteAt: Date | null }>();
    storedIncoming.forEach(r => storedInMap.set(r.fromUserId, { uv: r.upvoteCount, dv: r.downvoteCount, total: r.totalVotes, lastVoteAt: r.lastVoteAt }));

    function diffInteractions(kind: 'outgoing' | 'incoming', comp: Map<number, any>, stored: Map<number, any>) {
      const ids = new Set<number>([...comp.keys(), ...stored.keys()]);
      const mismatches: Array<{ targetUserId: number; computed: any; stored: any }> = [];
      ids.forEach(id => {
        const a = comp.get(id) || { uv: 0, dv: 0, total: 0, lastVoteAt: null };
        const b = stored.get(id) || { uv: 0, dv: 0, total: 0, lastVoteAt: null };
        if (Number(a.uv) !== Number(b.uv) || Number(a.dv) !== Number(b.dv) || Number(a.total) !== Number(b.total) || String(a.lastVoteAt || '') !== String(b.lastVoteAt || '')) {
          mismatches.push({ targetUserId: id, computed: a, stored: b });
        }
      });
      console.log(`\n${kind.toUpperCase()} interactions: computed=${comp.size}, stored=${stored.size}, mismatches=${mismatches.length}`);
      if (mismatches.length) {
        console.table(mismatches.map(m => ({ targetUserId: m.targetUserId, uv_comp: m.computed.uv, dv_comp: m.computed.dv, total_comp: m.computed.total, last_comp: m.computed.lastVoteAt, uv_store: m.stored.uv, dv_store: m.stored.dv, total_store: m.stored.total, last_store: m.stored.lastVoteAt })));
      }
      return mismatches.length;
    }

    const mismOut = diffInteractions('outgoing', outMap, storedOutMap);
    const mismIn = diffInteractions('incoming', inMap, storedInMap);

    // 4) Recompute Tag Preferences for this user (mirror UserSocialAnalysisJob rules)
    const tagComputed = await prisma.$queryRaw<Array<TagPrefRow>>`
      WITH user_tag_votes AS (
        SELECT 
          v."userId",
          unnest(pv.tags) as tag,
          v.direction,
          v.timestamp
        FROM "Vote" v
        JOIN "PageVersion" pv ON v."pageVersionId" = pv.id
        WHERE v."userId" = ${user.id}
          AND v.direction != 0
          AND pv.tags IS NOT NULL
          AND array_length(pv.tags, 1) > 0
          AND pv."validTo" IS NULL
          AND pv."isDeleted" = false
      ),
      tag_stats AS (
        SELECT 
          tag,
          COUNT(*) FILTER (WHERE direction = 1) as uv,
          COUNT(*) FILTER (WHERE direction = -1) as dv,
          COUNT(*) as total,
          MAX(timestamp) as "lastVoteAt"
        FROM user_tag_votes
        WHERE tag NOT IN ('页面', '重定向', '管理', '_cc')
        GROUP BY tag
        HAVING COUNT(*) >= 3
      )
      SELECT tag, uv, dv, total, "lastVoteAt" FROM tag_stats
      ORDER BY total DESC, uv DESC, dv ASC
    `;

    const tagStored = await prisma.userTagPreference.findMany({ where: { userId: user.id } });
    const tagMap = new Map<string, TagPrefRow>();
    tagComputed.forEach(t => tagMap.set(t.tag, { ...t, uv: Number(t.uv), dv: Number(t.dv), total: Number(t.total) }));
    const tagStoredMap = new Map<string, { uv: number; dv: number; total: number; lastVoteAt: Date | null }>();
    tagStored.forEach(t => tagStoredMap.set(t.tag, { uv: t.upvoteCount, dv: t.downvoteCount, total: t.totalVotes, lastVoteAt: t.lastVoteAt }));

    const tagKeys = new Set<string>([...tagMap.keys(), ...tagStoredMap.keys()]);
    const tagMismatches: Array<{ tag: string; computed: any; stored: any }> = [];
    tagKeys.forEach(tag => {
      const a = tagMap.get(tag) || { uv: 0, dv: 0, total: 0, lastVoteAt: null };
      const b = tagStoredMap.get(tag) || { uv: 0, dv: 0, total: 0, lastVoteAt: null };
      if (Number((a as any).uv) !== Number(b.uv) || Number((a as any).dv) !== Number(b.dv) || Number((a as any).total) !== Number(b.total) || String((a as any).lastVoteAt || '') !== String(b.lastVoteAt || '')) {
        tagMismatches.push({ tag, computed: a, stored: b });
      }
    });
    console.log(`\nTAG preferences: computed=${tagMap.size}, stored=${tagStoredMap.size}, mismatches=${tagMismatches.length}`);
    if (tagMismatches.length) {
      console.table(tagMismatches.map(m => ({ tag: m.tag, uv_comp: (m.computed as any).uv || 0, dv_comp: (m.computed as any).dv || 0, total_comp: (m.computed as any).total || 0, last_comp: (m.computed as any).lastVoteAt || null, uv_store: m.stored.uv, dv_store: m.stored.dv, total_store: m.stored.total, last_store: m.stored.lastVoteAt })));
    }

    const totalMismatches = mismOut + mismIn + tagMismatches.length;
    if (totalMismatches === 0) {
      console.log('\n✅ Verification PASSED: Aggregated data matches raw recomputation.');
    } else {
      console.log(`\n❌ Verification FOUND ${totalMismatches} mismatches. See tables above.`);
      process.exitCode = 1;
    }
  } catch (err) {
    console.error('Error verifying user interactions:', err);
    process.exitCode = 1;
  } finally {
    await disconnectPrisma();
  }
}

void main();




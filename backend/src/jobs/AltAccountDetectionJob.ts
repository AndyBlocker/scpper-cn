// src/jobs/AltAccountDetectionJob.ts
import { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../utils/db-connection.js';
import { Logger } from '../utils/Logger.js';

/**
 * 小号（同人多号）检测 Job。
 *
 * 把 2026-06-10 手工分析固化为可重复运行：基于 UserPixelEvent 的"账号 = clientHash/
 * softprint/visitorToken 信标"假设，找出在多个相互独立网络反复成对的账号，并用投票共现
 * （同向占比/影子比例/时间协同）与互投原创作品（自我推广）交叉验证，写入 SuspectedAltPair
 * 供站务复核。**只产出候选，不自动处置。**
 *
 * 口径要点：
 * - 仅 image-only 被动信号 + 公开投票数据，只读分析。
 * - 排除共享出口（同 IP 被 >8 个注册账号当信标 = VPN/NAT），避免把无关用户判成小号。
 * - clientHash 口径覆盖全部历史；softprint/visitorToken 为增强信号（go-forward 渐充）。
 * - 人工已置 confirmed/cleared 的对，只更新指标不覆盖 status。
 */

const INFRA_IP_USER_CAP = 8; // 同 IP 注册账号数上限，超过视为共享出口
const HASH_USER_MIN = 2;
const HASH_USER_MAX = 8;
const CANDIDATE_LIMIT = 500;

export type AltAccountDetectionOptions = {
  dryRun?: boolean;
  minScore?: number;
};

type PairMetric = {
  uaId: number; ubId: number; una: string; unb: string;
  sharedHashes: number; sharedSubnets: number; sharedSoftprints: number; sharedTokens: number;
  votesA: number; votesB: number;
  coVotes: number; sameDir: number; oppDir: number; sameHour: number;
  selfPromoAtoB: number; selfPromoBtoA: number;
};

function n(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string') { const x = Number(v); return Number.isFinite(x) ? x : 0; }
  return 0;
}

export class AltAccountDetectionJob {
  private prisma: PrismaClient;
  constructor(prisma?: PrismaClient) {
    this.prisma = prisma ?? getPrismaClient();
  }

  async run(options: AltAccountDetectionOptions = {}): Promise<{ candidates: number; written: number }> {
    const dryRun = Boolean(options.dryRun);
    const minScore = options.minScore ?? 4;
    Logger.info(`[alt-detect] start${dryRun ? ' [dry-run]' : ''} minScore=${minScore}`);

    const metrics = await this.computeNetworkAndVoteMetrics();
    Logger.info(`[alt-detect] 网络+投票候选对 ${metrics.length}`);
    const withPromo = await this.attachSelfPromotion(metrics);

    const scored = withPromo
      .map((m) => ({ m, score: this.score(m) }))
      .filter((x) => x.score >= minScore)
      .sort((a, b) => b.score - a.score);
    Logger.info(`[alt-detect] 达阈值候选 ${scored.length}（minScore=${minScore}）`);

    if (dryRun) {
      for (const { m, score } of scored.slice(0, 30)) {
        Logger.info(
          `[alt-detect] ${m.una} ↔ ${m.unb} score=${score.toFixed(1)} ` +
          `nets=${m.sharedSubnets} hashes=${m.sharedHashes} sp=${m.sharedSoftprints} tok=${m.sharedTokens} ` +
          `co=${m.coVotes} same=${m.sameDir} opp=${m.oppDir} hr=${m.sameHour} promo=${m.selfPromoAtoB}/${m.selfPromoBtoA}`
        );
      }
      return { candidates: scored.length, written: 0 };
    }

    let written = 0;
    for (const { m, score } of scored) {
      await this.upsertPair(m, score);
      written++;
    }
    Logger.info(`[alt-detect] 写入 SuspectedAltPair ${written} 行`);
    return { candidates: scored.length, written };
  }

  /** 网络共享（clientHash/subnet/softprint/token）+ 投票共现，一次性算出候选对。 */
  private async computeNetworkAndVoteMetrics(): Promise<PairMetric[]> {
    const rows = await this.prisma.$queryRawUnsafe<any[]>(`
      WITH base AS (
        SELECT DISTINCT "clientHash",
               split_part("clientIp",'.',1)||'.'||split_part("clientIp",'.',2)||'.'||split_part("clientIp",'.',3) AS subnet24,
               "softprint", "visitorToken", "userId", username
        FROM "UserPixelEvent"
        WHERE "userId" IS NOT NULL AND username IS NOT NULL AND trim(username) <> ''
      ),
      hash_small AS (
        SELECT "clientHash" FROM base
        GROUP BY "clientHash" HAVING count(distinct "userId") BETWEEN ${HASH_USER_MIN} AND ${HASH_USER_MAX}
      ),
      ip_breadth AS (
        SELECT split_part("clientIp",'.',1)||'.'||split_part("clientIp",'.',2)||'.'||split_part("clientIp",'.',3) AS subnet24,
               count(distinct "userId") ip_users
        FROM "UserPixelEvent" WHERE "userId" IS NOT NULL
        GROUP BY 1
      ),
      pairs AS (
        -- 携带 a/b 两侧的 softprint/token,共享=两侧都有且相等(单侧多样性不算共享)。
        -- 注:clientHash 为明文 ip|ua,故同 ch 的 a/b 必同 IP 同 subnet;b 侧 infra 过滤为防御性冗余。
        SELECT a."userId" ua, a.username una, b."userId" ub, b.username unb,
               a."clientHash" ch, a.subnet24,
               a."softprint" sp_a, b."softprint" sp_b,
               a."visitorToken" tok_a, b."visitorToken" tok_b
        FROM base a
        JOIN base b ON a."clientHash"=b."clientHash" AND a."userId" < b."userId"
        JOIN hash_small h ON h."clientHash"=a."clientHash"
        JOIN ip_breadth iba ON iba.subnet24=a.subnet24 AND iba.ip_users <= ${INFRA_IP_USER_CAP}
        JOIN ip_breadth ibb ON ibb.subnet24=b.subnet24 AND ibb.ip_users <= ${INFRA_IP_USER_CAP}
      ),
      pair_agg AS (
        SELECT ua, una, ub, unb,
               count(distinct ch) shared_hashes,
               count(distinct subnet24) shared_subnets,
               count(distinct sp_a) FILTER (WHERE sp_a IS NOT NULL AND sp_a = sp_b) shared_softprints,
               count(distinct tok_a) FILTER (WHERE tok_a IS NOT NULL AND tok_a = tok_b) shared_tokens
        FROM pairs GROUP BY ua, una, ub, unb
        HAVING count(distinct ch) >= 1
      ),
      ru AS ( SELECT ua uid FROM pair_agg UNION SELECT ub FROM pair_agg ),
      lv AS (
        SELECT "userId", "pageId", direction, ts FROM (
          SELECT v."userId", pv."pageId", v.direction, v.timestamp ts,
                 row_number() OVER (PARTITION BY v."userId", pv."pageId" ORDER BY v.timestamp DESC, v.id DESC) rn
          FROM "Vote" v JOIN "PageVersion" pv ON pv.id=v."pageVersionId"
          WHERE v."userId" IN (SELECT uid FROM ru) AND v.direction <> 0
        ) z WHERE rn=1
      ),
      tot AS ( SELECT "userId", count(*) n FROM lv GROUP BY "userId" ),
      co AS (
        SELECT p.ua, p.ub,
               count(*) co_pages,
               count(*) FILTER (WHERE la.direction=lb.direction) same_dir,
               count(*) FILTER (WHERE la.direction<>lb.direction) opp_dir,
               count(*) FILTER (WHERE la.direction=lb.direction AND abs(extract(epoch FROM la.ts-lb.ts))<3600) same_hr
        FROM pair_agg p
        JOIN lv la ON la."userId"=p.ua
        JOIN lv lb ON lb."userId"=p.ub AND lb."pageId"=la."pageId"
        GROUP BY p.ua, p.ub
      )
      SELECT p.ua, p.una, p.ub, p.unb,
             p.shared_hashes, p.shared_subnets, p.shared_softprints, p.shared_tokens,
             COALESCE(ta.n,0) votes_a, COALESCE(tb.n,0) votes_b,
             COALESCE(c.co_pages,0) co_pages, COALESCE(c.same_dir,0) same_dir,
             COALESCE(c.opp_dir,0) opp_dir, COALESCE(c.same_hr,0) same_hr
      FROM pair_agg p
      LEFT JOIN tot ta ON ta."userId"=p.ua
      LEFT JOIN tot tb ON tb."userId"=p.ub
      LEFT JOIN co c ON c.ua=p.ua AND c.ub=p.ub
      WHERE p.shared_hashes >= 2 OR COALESCE(c.same_dir,0) >= 15
      ORDER BY p.shared_subnets DESC, COALESCE(c.same_dir,0) DESC
      LIMIT ${CANDIDATE_LIMIT}
    `);

    return rows.map((r) => ({
      uaId: n(r.ua), ubId: n(r.ub), una: r.una, unb: r.unb,
      sharedHashes: n(r.shared_hashes), sharedSubnets: n(r.shared_subnets),
      sharedSoftprints: n(r.shared_softprints), sharedTokens: n(r.shared_tokens),
      votesA: n(r.votes_a), votesB: n(r.votes_b),
      coVotes: n(r.co_pages), sameDir: n(r.same_dir), oppDir: n(r.opp_dir), sameHour: n(r.same_hr),
      selfPromoAtoB: 0, selfPromoBtoA: 0,
    }));
  }

  /** 互投原创作品（自我推广）：B 给 A 原创页 up 票数 / A 给 B 原创页 up 票数。 */
  private async attachSelfPromotion(metrics: PairMetric[]): Promise<PairMetric[]> {
    if (metrics.length === 0) return metrics;
    const ids = Array.from(new Set(metrics.flatMap((m) => [m.uaId, m.ubId])));
    // 相关用户的当前 up 票 + 原创页
    const promo = await this.prisma.$queryRawUnsafe<any[]>(`
      WITH ids(uid) AS (SELECT unnest($1::int[])),
      lv AS (
        SELECT "userId", "pageId" FROM (
          SELECT v."userId", pv."pageId",
                 row_number() OVER (PARTITION BY v."userId", pv."pageId" ORDER BY v.timestamp DESC, v.id DESC) rn,
                 v.direction
          FROM "Vote" v JOIN "PageVersion" pv ON pv.id=v."pageVersionId"
          WHERE v."userId" IN (SELECT uid FROM ids) AND v.direction = 1
        ) z WHERE rn=1
      ),
      authored AS (
        SELECT DISTINCT a."userId", pv."pageId"
        FROM "Attribution" a JOIN "PageVersion" pv ON pv.id=a."pageVerId" AND pv."validTo" IS NULL
        WHERE a."userId" IN (SELECT uid FROM ids) AND a.type IN ('AUTHOR','SUBMITTER')
      )
      SELECT v."userId" voter, au."userId" author, count(*) cnt
      FROM lv v JOIN authored au ON au."pageId"=v."pageId" AND au."userId" <> v."userId"
      GROUP BY 1,2
    `, ids);

    const key = (voter: number, author: number) => `${voter}|${author}`;
    const map = new Map<string, number>();
    for (const r of promo) map.set(key(n(r.voter), n(r.author)), n(r.cnt));
    for (const m of metrics) {
      m.selfPromoAtoB = map.get(key(m.uaId, m.ubId)) ?? 0; // A 投 B 原创
      m.selfPromoBtoA = map.get(key(m.ubId, m.uaId)) ?? 0; // B 投 A 原创
    }
    return metrics;
  }

  private score(m: PairMetric): number {
    const agree = m.sameDir + m.oppDir > 0 ? m.sameDir / (m.sameDir + m.oppDir) : 0;
    let s = 0;
    s += 3.0 * m.sharedSubnets;                 // 独立网络数（最强）
    s += 1.0 * Math.min(m.sharedHashes, 10);
    s += 1.0 * m.sharedSoftprints;
    s += 2.5 * m.sharedTokens;                  // 同 ETag token = 同浏览器
    s += 0.12 * m.sameDir;
    s += 0.10 * m.sameHour;
    s += (agree >= 0.9 && m.coVotes >= 10) ? 2.5 : 0;
    s += 0.3 * (m.selfPromoAtoB + m.selfPromoBtoA); // 自我推广
    s -= 0.5 * m.oppDir;                        // 投票分歧降可疑度
    return Math.max(0, s);
  }

  private agreePct(m: PairMetric): number | null {
    const d = m.sameDir + m.oppDir;
    return d > 0 ? Math.round((100 * m.sameDir) / d) : null;
  }
  private shadowPct(m: PairMetric): number | null {
    const min = Math.min(m.votesA, m.votesB);
    return min > 0 ? Math.round((100 * m.coVotes) / min) : null;
  }

  private async upsertPair(m: PairMetric, score: number): Promise<void> {
    const evidence = JSON.stringify({
      votesA: m.votesA, votesB: m.votesB, sharedTokens: m.sharedTokens, sharedSoftprints: m.sharedSoftprints,
    });
    // 人工已置 status 不覆盖；只刷新指标与 score、updatedAt。
    await this.prisma.$executeRawUnsafe(`
      INSERT INTO "SuspectedAltPair"
        ("userIdA","userIdB","usernameA","usernameB","sharedHashes","sharedSubnets","sharedSoftprints",
         "sharedTokens","coVotes","sameDir","oppDir","sameHour","agreePct","shadowPct","selfPromoAtoB","selfPromoBtoA",
         score, status, evidence, "firstDetectedAt", "updatedAt")
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'candidate',$18::jsonb, now(), now())
      ON CONFLICT ("userIdA","userIdB") DO UPDATE SET
        "usernameA"=EXCLUDED."usernameA", "usernameB"=EXCLUDED."usernameB",
        "sharedHashes"=EXCLUDED."sharedHashes", "sharedSubnets"=EXCLUDED."sharedSubnets",
        "sharedSoftprints"=EXCLUDED."sharedSoftprints", "sharedTokens"=EXCLUDED."sharedTokens",
        "coVotes"=EXCLUDED."coVotes", "sameDir"=EXCLUDED."sameDir", "oppDir"=EXCLUDED."oppDir",
        "sameHour"=EXCLUDED."sameHour", "agreePct"=EXCLUDED."agreePct", "shadowPct"=EXCLUDED."shadowPct",
        "selfPromoAtoB"=EXCLUDED."selfPromoAtoB", "selfPromoBtoA"=EXCLUDED."selfPromoBtoA",
        score=EXCLUDED.score, evidence=EXCLUDED.evidence, "updatedAt"=now()
    `,
      m.uaId, m.ubId, m.una, m.unb, m.sharedHashes, m.sharedSubnets, m.sharedSoftprints,
      m.sharedTokens, m.coVotes, m.sameDir, m.oppDir, m.sameHour, this.agreePct(m), this.shadowPct(m),
      m.selfPromoAtoB, m.selfPromoBtoA, score, evidence
    );
  }
}

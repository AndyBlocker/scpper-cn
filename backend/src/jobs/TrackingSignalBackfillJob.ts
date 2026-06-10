// src/jobs/TrackingSignalBackfillJob.ts
import { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../utils/db-connection.js';
import { Logger } from '../utils/Logger.js';

/**
 * 历史事件信号回填：从 tracking_debug_event 把 Accept-Language / sec-ch-ua-platform
 * 回填到 PageViewEvent / UserPixelEvent 的新列（仅填 NULL，幂等）。
 *
 * 这两个字段只有 debug 表采集过、无法从事件已存列(clientIp/userAgent)再生，故必须从 debug 表拷贝。
 * uaBrandMajor / uaFamily / softprint 含解析/派生逻辑，留 go-forward 由写侧填充，避免 SQL 侧逻辑漂移。
 *
 * 匹配：debug 与其对应事件在同一请求写入，共享 (clientHash, kind→表, page_id/user_id) 且时间相近。
 * debug 表仅 2026-04-07 起，故只回填该时间窗内事件。全程只读 debug + 只填 NULL，可逆（置回 NULL）。
 */

const DEBUG_TABLE = 'tracking_debug_event';
const DEBUG_START = '2026-04-07';
const DEFAULT_BATCH = 20000;

export type TrackingSignalBackfillOptions = {
  dryRun?: boolean;
  batchSize?: number;
};

type Target = {
  table: 'PageViewEvent' | 'UserPixelEvent';
  kind: 'page' | 'user';
  idCol: 'page_id' | 'user_id';
  evIdCol: 'pageId' | 'userId';
};

const TARGETS: Target[] = [
  { table: 'PageViewEvent', kind: 'page', idCol: 'page_id', evIdCol: 'pageId' },
  { table: 'UserPixelEvent', kind: 'user', idCol: 'user_id', evIdCol: 'userId' },
];

function num(v: unknown): number {
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'number') return v;
  if (typeof v === 'string') { const x = Number(v); return Number.isFinite(x) ? x : 0; }
  return 0;
}

export class TrackingSignalBackfillJob {
  private prisma: PrismaClient;
  constructor(prisma?: PrismaClient) {
    this.prisma = prisma ?? getPrismaClient();
  }

  async run(options: TrackingSignalBackfillOptions = {}): Promise<void> {
    const dryRun = Boolean(options.dryRun);
    const batch = options.batchSize ?? DEFAULT_BATCH;
    Logger.info(`[signal-backfill] start${dryRun ? ' [dry-run]' : ''} batch=${batch} from=${DEBUG_START}`);

    for (const t of TARGETS) {
      await this.backfillTable(t, batch, dryRun);
    }
  }

  private async backfillTable(t: Target, batch: number, dryRun: boolean): Promise<void> {
    const pending = await this.prisma.$queryRawUnsafe<Array<{ c: bigint }>>(
      `SELECT count(*)::bigint c FROM "${t.table}"
        WHERE "acceptLanguage" IS NULL AND "createdAt" >= $1::date`,
      DEBUG_START
    );
    const total = num(pending[0]?.c);
    Logger.info(`[signal-backfill] ${t.table}: ${total.toLocaleString()} 行待回填（acceptLanguage IS NULL，${DEBUG_START} 起）`);
    if (total === 0 || dryRun) return;

    // 按 id 分批 UPDATE，匹配最近的 debug 行（同 clientHash + 同 page/user + 时间窗 1 小时内）。
    const bounds = await this.prisma.$queryRawUnsafe<Array<{ mn: number | null; mx: number | null }>>(
      `SELECT min(id) mn, max(id) mx FROM "${t.table}"
        WHERE "acceptLanguage" IS NULL AND "createdAt" >= $1::date`,
      DEBUG_START
    );
    let lo = num(bounds[0]?.mn);
    const hi = num(bounds[0]?.mx);
    if (!lo || !hi) return;

    let updated = 0;
    while (lo <= hi) {
      const upperExclusive = lo + batch;
      const res = await this.prisma.$executeRawUnsafe(
        `UPDATE "${t.table}" ev SET
            "acceptLanguage" = d.al,
            "uaPlatform" = COALESCE(ev."uaPlatform", d.platform)
         FROM LATERAL (
           SELECT btrim(de.headers->>'accept-language') al,
                  btrim(btrim(de.headers->>'sec-ch-ua-platform'), '"') platform
             FROM "${DEBUG_TABLE}" de
            WHERE de.kind = $3
              AND de.client_hash = ev."clientHash"
              AND de.${t.idCol} = ev."${t.evIdCol}"
              AND de.created_at BETWEEN ev."createdAt" - INTERVAL '1 hour' AND ev."createdAt" + INTERVAL '1 hour'
              AND de.headers ? 'accept-language'
            ORDER BY abs(extract(epoch FROM de.created_at - ev."createdAt")) ASC
            LIMIT 1
         ) d
         WHERE ev.id >= $1 AND ev.id < $2
           AND ev."acceptLanguage" IS NULL
           AND d.al IS NOT NULL AND d.al <> ''`,
        lo, upperExclusive, t.kind
      );
      const n = num(res);
      updated += n;
      if (n > 0) Logger.info(`[signal-backfill] ${t.table}: id[${lo},${upperExclusive}) +${n}（累计 ${updated.toLocaleString()}）`);
      lo = upperExclusive;
    }
    Logger.info(`[signal-backfill] ${t.table}: 回填完成，共 ${updated.toLocaleString()} 行`);
  }
}

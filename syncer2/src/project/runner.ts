import type { Pool, PoolClient } from 'pg';
import { query, withTransaction } from '../store/db.js';
import { projectPageDailyStats, projectUserAttrDaily, projectVoteDaily } from './daily.js';
import { projectPageStats } from './pageStats.js';
import { projectSiteOverviewDaily, projectSiteStats } from './siteOverview.js';
import { projectUserTagPreference, projectUserVoteInteraction } from './social.js';
import { asNumber } from './sql.js';
import {
  L2_PROJECTIONS,
  type ProjectOptions,
  type ProjectionApply,
  type ProjectionName,
  type ProjectionRunResult,
} from './types.js';
import { projectUserPage } from './userPage.js';
import { projectUserStats } from './userStats.js';

const APPLY: Readonly<Record<ProjectionName, ProjectionApply>> = {
  'serve.page_stats': projectPageStats,
  'serve.vote_daily': projectVoteDaily,
  'serve.user_attr_daily': projectUserAttrDaily,
  'serve.user_page': projectUserPage,
  'serve.user_stats': projectUserStats,
  'serve.user_vote_interaction': projectUserVoteInteraction,
  'serve.user_tag_preference': projectUserTagPreference,
  'serve.page_daily_stats': projectPageDailyStats,
  'serve.site_stats': projectSiteStats,
  'serve.site_overview_daily': projectSiteOverviewDaily,
};

/** 依赖先后：user_stats 先完成 B2/B4，自洽后站点总览再发布 B1 快照。 */
export const DEFAULT_PROJECTION_ORDER: readonly ProjectionName[] = [
  'serve.page_stats',
  'serve.vote_daily',
  'serve.user_attr_daily',
  'serve.user_vote_interaction',
  'serve.user_tag_preference',
  'serve.page_daily_stats',
  'serve.user_page',
  'serve.user_stats',
  'serve.site_stats',
  'serve.site_overview_daily',
];

interface CursorRow {
  last_seq: string;
  updated_at: Date;
  rebuild_from: string;
  table_comment: string | null;
}

interface WatermarkRow {
  watermark: string | null;
}

interface AdvanceRow {
  last_seq: string;
}

function alwaysRefresh(projection: ProjectionName): boolean {
  return projection === 'serve.user_page'
    || projection === 'serve.user_stats';
}

/**
 * B2/B4 断言要求 user_stats 同轮看到 user_attr_daily 删除负柱与 user_page 现存作品集合；
 * 两张 B1 站点总览又依赖刚刷新的 user_stats，所以选择下游时显式补齐整条依赖。
 */
export function expandProjectionDependencies(
  requested: readonly ProjectionName[],
): ProjectionName[] {
  const wanted = new Set(requested);
  if (
    wanted.has('serve.site_stats')
    || wanted.has('serve.site_overview_daily')
  ) {
    wanted.add('serve.user_stats');
  }
  if (wanted.has('serve.user_stats')) {
    wanted.add('serve.user_attr_daily');
    wanted.add('serve.user_page');
  }
  return DEFAULT_PROJECTION_ORDER.filter((name) => wanted.has(name));
}

export async function runProjection(
  pool: Pool,
  projection: ProjectionName,
  options: ProjectOptions = {},
): Promise<ProjectionRunResult> {
  const started = Date.now();
  const rebuild = options.rebuild === true;
  const maxSeqSpan = options.maxSeqSpan;
  const targetSeq = options.targetSeq;
  if (
    maxSeqSpan !== undefined
    && (!Number.isSafeInteger(maxSeqSpan) || maxSeqSpan < 1)
  ) {
    throw new RangeError(`maxSeqSpan 必须是正安全整数，收到 ${String(maxSeqSpan)}`);
  }
  if (
    targetSeq !== undefined
    && (!Number.isSafeInteger(targetSeq) || targetSeq < 0)
  ) {
    throw new RangeError(`targetSeq 必须是非负安全整数，收到 ${String(targetSeq)}`);
  }
  if (rebuild && (maxSeqSpan !== undefined || targetSeq !== undefined)) {
    throw new Error('rebuild 会先清表，禁止同时使用 catch-up 的 maxSeqSpan/targetSeq');
  }
  /*
   * B2：省略开关时必须是 false——作者排行回答“谁的现存作品成就最高”。
   * 已删页约 59% 是踩，纳入会惩罚删过稿的人。显式 true 仅保留作对账/诊断，
   * 不能因为 B1 站点累计总览包含已删页就把这里“统一”为 true。
   */
  const includeDeletedPages = options.includeDeletedPages === true;

  /*
   * 摄入侧抢到 gate 屏障锁 ⇒ advance_projection_cursor 抛 55006。这是 safe_seq_watermark()
   * 契约里的良性信号（「本轮不推进游标」），不是故障：前置检查已有同名的 busy 出口，
   * 但 gate 可能在前置检查通过之后、推进之前才被摄入侧抢走，形成活库竞态。
   * 此前未捕获 ⇒ 整轮 project 非零退出并告警，表现为「摄入越忙、投影越爱失败」。
   * 事务在 55006 后已处于失败态，必须在事务边界之外转换，让 withTransaction 正常回滚。
   */
  // 竞态回滚后要如实报出当轮读到的游标位置，不能编造 0/-1。
  let observedPreviousSeq = 0;
  // busy 出口必须带真实滞后：全填 0 会让「长期推不动」永远无法与「暂时抢不到锁」区分。
  let observedCursorUpdatedAt: Date | string | null = null;
  try {
    return await runProjectionInTransaction();
  } catch (err) {
    if (isIngestGateBusy(err)) {
      return {
        projection,
        status: 'busy',
        previousSeq: observedPreviousSeq,
        fromSeq: null,
        watermark: null,
        advancedTo: observedPreviousSeq,
        rebuild,
        includeDeletedPages,
        affectedKeys: 0,
        rowsWritten: 0,
        lagBeforeSeconds: cursorLagSeconds(observedCursorUpdatedAt),
        durationMs: Date.now() - started,
        notes: [
          '推进游标时摄入侧已抢占 gate 屏障锁（SQLSTATE 55006）；本轮整体回滚，未推进游标',
        ],
      };
    }
    throw err;
  }

  function runProjectionInTransaction(): Promise<ProjectionRunResult> {
  return withTransaction(pool, `project:${projection}`, async (client) => {
    // 每张投影一把事务级锁。锁先于游标读取，两个 projector 不可能折叠同一窗口。
    await query(
      client,
      'project:advisory_lock',
      `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 72391231))`,
      [projection],
    );

    // 必须在任何 TRUNCATE/DELETE/UPSERT 与 cursor=0 之前检查总闸/投影域闸。
    await query(
      client,
      'project:write_freeze',
      `SELECT meta.assert_writes_allowed('projection')`,
    );

    const cursorRows = await query<CursorRow>(
      client,
      'project:cursor_contract',
      `SELECT c.last_seq::text,
              c.updated_at,
              c.rebuild_from,
              obj_description($2::regclass, 'pg_class') AS table_comment
         FROM meta.projection_cursor c
        WHERE c.projection = $1::text
        FOR UPDATE`,
      [projection, projection],
    );
    const cursor = cursorRows.rows[0];
    if (!cursor) {
      throw new Error(`${projection} 未登记在 meta.projection_cursor，拒绝投影`);
    }
    if (cursor.table_comment === null || cursor.rebuild_from !== cursor.table_comment) {
      throw new Error(
        `${projection} rebuild_from 漂移：cursor=${JSON.stringify(cursor.rebuild_from)}，` +
          `COMMENT=${JSON.stringify(cursor.table_comment)}`,
      );
    }

    const previousSeq = asNumber(cursor.last_seq, `${projection}.last_seq`);
    observedPreviousSeq = previousSeq;
    observedCursorUpdatedAt = cursor.updated_at;
    const watermarkRows = await query<WatermarkRow>(
      client,
      'project:safe_watermark',
      `SELECT meta.safe_seq_watermark()::text AS watermark`,
    );
    const rawWatermark = watermarkRows.rows[0]?.watermark ?? null;
    if (rawWatermark === null) {
      return {
        projection,
        status: 'busy',
        previousSeq,
        fromSeq: null,
        watermark: null,
        advancedTo: previousSeq,
        rebuild,
        includeDeletedPages,
        affectedKeys: 0,
        rowsWritten: 0,
        lagBeforeSeconds: cursorLagSeconds(cursor.updated_at),
        durationMs: Date.now() - started,
        notes: ['摄入侧持续持有 gate 屏障锁；本轮没有猜水位，也没有推进游标'],
      };
    }
    const safeWatermark = asNumber(rawWatermark, 'safe_seq_watermark');
    const targetWatermark =
      targetSeq === undefined ? safeWatermark : Math.min(safeWatermark, targetSeq);
    const watermark =
      maxSeqSpan === undefined
        ? targetWatermark
        : Math.min(targetWatermark, previousSeq + maxSeqSpan);
    if (!rebuild && watermark < previousSeq) {
      throw new Error(
        `${projection} 游标 ${previousSeq} 超过安全水位 ${watermark}；拒绝倒退或继续写入`,
      );
    }

    const lagBeforeSeconds =
      watermark > previousSeq
        ? Math.max(0, Math.floor((Date.now() - new Date(cursor.updated_at).getTime()) / 1_000))
        : 0;

    if (!rebuild && watermark === previousSeq && !alwaysRefresh(projection)) {
      return {
        projection,
        status: 'idle',
        previousSeq,
        fromSeq: null,
        watermark,
        advancedTo: previousSeq,
        rebuild,
        includeDeletedPages,
        affectedKeys: 0,
        rowsWritten: 0,
        lagBeforeSeconds,
        durationMs: Date.now() - started,
      };
    }

    if (rebuild) {
      // handler 在同一事务里执行目标表的 TRUNCATE（page_daily_stats 例外）与重放。
      await query(
        client,
        'project:reset_cursor',
        `UPDATE meta.projection_cursor
            SET last_seq = 0, updated_at = now()
          WHERE projection = $1`,
        [projection],
      );
    }

    const fromSeq = rebuild ? 1 : previousSeq + 1;
    const applied = await APPLY[projection](client, {
      fromSeq,
      toSeq: watermark,
      previousSeq,
      rebuild,
      includeDeletedPages,
    });

    let advancedTo = previousSeq;
    if (rebuild || watermark > previousSeq) {
      /*
       * 禁止直接 UPDATE 到 fact_seq.last_value。数据库函数会再次读取
       * meta.safe_seq_watermark() 并把调用方给的 watermark 二次钳制。
       */
      const advanced = await query<AdvanceRow>(
        client,
        'project:advance_cursor',
        `SELECT meta.advance_projection_cursor($1, $2::bigint)::text AS last_seq`,
        [projection, watermark],
      );
      advancedTo = asNumber(advanced.rows[0]?.last_seq, `${projection}.advanced_seq`);
      if (advancedTo > watermark) {
        throw new Error(
          `${projection} 游标推进到 ${advancedTo}，越过本轮已消费水位 ${watermark}`,
        );
      }
    }

    const catchUpNotes =
      watermark < safeWatermark
        ? [
            `catch-up 水位已钳制：safe=${safeWatermark}，本事务消费至 ${watermark}`,
          ]
        : [];
    return {
      projection,
      status: 'ok',
      previousSeq,
      fromSeq,
      watermark,
      advancedTo,
      rebuild,
      includeDeletedPages,
      ...applied,
      notes: [...(applied.notes ?? []), ...catchUpNotes],
      lagBeforeSeconds,
      durationMs: Date.now() - started,
    };
  });
  }
}

/**
 * 只认 SQLSTATE 55006（advance_projection_cursor 拿不到 gate 屏障锁）。
 * 刻意不按错误文本匹配：文本会随迁移改写而漂移，而按 code 匹配不会把别的
 * 55xxx（object_not_in_prerequisite_state）一并吞掉。
 */
/**
 * busy 是否应升级为整轮失败。
 *
 * 「暂时抢不到 gate」与「长期推不动」是两件事：前者每轮自愈，把它算作失败会让
 * 摄入越忙告警越密，通道随即失去意义；后者必须报。判据只看 busy 项的游标滞后。
 */
export function selectStalledBusy(
  results: readonly Pick<ProjectionRunResult, 'projection' | 'status' | 'lagBeforeSeconds'>[],
  thresholdSec: number,
): string[] {
  if (!Number.isSafeInteger(thresholdSec) || thresholdSec < 0) {
    throw new RangeError(`busy 停滞阈值必须是非负安全整数，收到 ${String(thresholdSec)}`);
  }
  return results
    .filter((r) => r.status === 'busy' && r.lagBeforeSeconds > thresholdSec)
    .map((r) => r.projection);
}

/** 游标上次推进至今的秒数；缺失时返回 0（未知不当成停滞，避免反向误报）。 */
function cursorLagSeconds(updatedAt: Date | string | null): number {
  if (updatedAt === null) return 0;
  const ms = updatedAt instanceof Date ? updatedAt.getTime() : new Date(updatedAt).getTime();
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.floor((Date.now() - ms) / 1_000));
}

function isIngestGateBusy(err: unknown): boolean {
  return (
    typeof err === 'object'
    && err !== null
    && (err as { code?: unknown }).code === '55006'
  );
}

export async function runProjections(
  pool: Pool,
  requested: readonly ProjectionName[] = L2_PROJECTIONS,
  options: ProjectOptions = {},
): Promise<ProjectionRunResult[]> {
  const plan = expandProjectionDependencies(requested);
  const results: ProjectionRunResult[] = [];
  /*
   * 一轮内把水位钉死。
   *
   * 每张投影各自取一次 safe_seq_watermark 时，摄入侧在两张投影之间提交的事实会让
   * 后跑的那张多消费一段，于是 B2/B4 这类【跨投影】不变量是在撕裂快照上求值的：
   * user_attr_daily 停在 seq=N、user_stats 已到 N+k，曲线末值与总评分本就不该相等。
   * 症状是 project 偶发失败（如 user 40015：cum 276 vs total 277），重跑即消失。
   * 漂移对账上线后评分改动变频繁，这个竞态只会更常见。
   *
   * 钉住不削弱任何保护：DB 侧 advance_projection_cursor 仍会二次钳制到它自己的
   * 安全水位，targetSeq 只能让本轮消费得更少，绝不可能更多。
   */
  let effective = options;
  if (!options.rebuild && options.targetSeq === undefined) {
    const pinned = await readSafeWatermark(pool);
    // null = 摄入侧正持锁；不猜水位，交由各投影走既有 busy 出口。
    if (pinned !== null) effective = { ...options, targetSeq: pinned };
  }
  // 顺序执行是依赖契约，不做 Promise.all：user_stats 必须在 user_page 提交后运行。
  for (const projection of plan) {
    results.push(await runProjection(pool, projection, effective));
  }
  return results;
}

/** 事务外读一次安全水位，仅用于把一轮投影钉在同一 seq 上。 */
async function readSafeWatermark(pool: Pool): Promise<number | null> {
  const rows = await query<WatermarkRow>(
    pool,
    'project:pin_watermark',
    `SELECT meta.safe_seq_watermark()::text AS watermark`,
  );
  const raw = rows.rows[0]?.watermark ?? null;
  return raw === null ? null : asNumber(raw, 'safe_seq_watermark');
}

/** 供测试与运维探针复用，明确验证冻结检查发生在写入之前。 */
export async function assertProjectionWritesAllowed(client: PoolClient): Promise<void> {
  await query(
    client,
    'project:write_freeze_probe',
    `SELECT meta.assert_writes_allowed('projection')`,
  );
}

import type { PoolClient } from 'pg';

/**
 * M8 首批八张 L2 投影 + 前端五项口径补入的两张站点总览投影。
 *
 * 值使用完整表名，必须与 meta.projection_cursor.projection 逐字一致。
 */
export const L2_PROJECTIONS = [
  'serve.page_stats',
  'serve.vote_daily',
  'serve.user_attr_daily',
  'serve.user_page',
  'serve.user_stats',
  'serve.user_vote_interaction',
  'serve.user_tag_preference',
  'serve.page_daily_stats',
  'serve.site_stats',
  'serve.site_overview_daily',
] as const;

export type ProjectionName = (typeof L2_PROJECTIONS)[number];

export interface ProjectionWindow {
  fromSeq: number;
  toSeq: number;
  previousSeq: number;
  rebuild: boolean;
  includeDeletedPages: boolean;
}

export interface ProjectionApplyResult {
  affectedKeys: number;
  rowsWritten: number;
  rowsDeleted?: number;
  /** 需要在交付报告里显式暴露的口径/结构说明。 */
  notes?: string[];
}

export type ProjectionApply = (
  client: PoolClient,
  window: ProjectionWindow,
) => Promise<ProjectionApplyResult>;

export interface ProjectionRunResult extends ProjectionApplyResult {
  projection: ProjectionName;
  status: 'ok' | 'idle' | 'busy';
  previousSeq: number;
  fromSeq: number | null;
  watermark: number | null;
  advancedTo: number;
  rebuild: boolean;
  includeDeletedPages: boolean;
  lagBeforeSeconds: number;
  durationMs: number;
}

export interface ProjectOptions {
  rebuild?: boolean;
  includeDeletedPages?: boolean;
  /** 单事务最多消费多少个 fact_seq；仅用于首次 catch-up 的断点窗口。 */
  maxSeqSpan?: number;
  /** 把本轮水位钳制到启动时快照，避免全量期间追逐新写入。 */
  targetSeq?: number;
}

export function isProjectionName(value: string): value is ProjectionName {
  return (L2_PROJECTIONS as readonly string[]).includes(value);
}

/** CLI 允许短名，但内部与游标交互时一律转成完整表名。 */
export function normalizeProjectionName(value: string): ProjectionName {
  const normalized = value.startsWith('serve.') ? value : `serve.${value}`;
  if (!isProjectionName(normalized)) {
    throw new Error(
      `未知 L2 投影「${value}」；允许值：${L2_PROJECTIONS.map((v) => v.slice('serve.'.length)).join(', ')}`,
    );
  }
  return normalized;
}

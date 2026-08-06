export const SQL_TUNING_CONSTANTS = Object.freeze({
  VOTE_SWEEP_ACTIVITY_DAYS: {
    defaultValue: 90,
    reason: '盲扫只覆盖近期有投票活动的页面',
  },
  VOTE_SWEEP_INTERVAL_DAYS: {
    defaultValue: 30,
    reason: 'L1 看不见的抵消型变化之低优先兜底周期',
  },
  NEW_PAGE_WINDOW_DAYS: {
    defaultValue: 7,
    reason: '83.2% 短命删除页发生在发布后七天内',
  },
  NEW_PAGE_INTERVAL_HOURS: {
    defaultValue: 3,
    reason: '短命页完整投票高频复查周期',
  },
} as const);

export type SqlTuningConstantName = keyof typeof SQL_TUNING_CONSTANTS;

/**
 * SQL 参数位的机械标记。返回原值，不改变 node-pg 行为；AST 检查只承认 query() 第四参数
 * 数组里的本函数调用。删掉绑定或把常量重新硬编码进 SQL，check:sql-tuning 会失败。
 */
export function bindSqlTuning(name: SqlTuningConstantName, value: number): number {
  if (!Number.isFinite(value)) throw new RangeError(`${name} SQL 调参值必须有限，收到 ${value}`);
  return value;
}

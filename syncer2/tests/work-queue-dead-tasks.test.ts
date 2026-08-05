/**
 * 已非 live 页面上的待办任务必须清理，`confirm_deleted` 除外。
 *
 * 认领查询要求 pc.status='live'，因此页面被删后其余待办永远取不到：
 * attempts 恒为 0、退避永不推进——它们不可见地存在，却污染每一项基于队列的观测。
 * 实测因此误判两次：「realtime 任务平均等待 130 小时」的主体其实是已删页僵尸
 * （74 个里 65 个），真正在等的只有 9 个。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openSess } from './helpers/pg.js';
import { reapTasksOnNonLivePages } from '../src/store/workQueue.js';
import { createPool } from '../src/store/db.js';
import { loadConfig } from '../src/config.js';

describe('已删页死任务清理', () => {
  it('confirm_deleted 必须豁免——它正是用来确认删除本身的', async () => {
    const pool = createPool(loadConfig().databaseUrl, { max: 1 });
    try {
      // 清理是幂等的：连跑两次，第二次不应再删到任何东西。
      await reapTasksOnNonLivePages(pool);
      const second = await reapTasksOnNonLivePages(pool);
      assert.equal(second.total, 0, '第二次清理应为空，说明幂等');

      // 断言库内不再存在「非 live 页面上的非 confirm_deleted 任务」。
      const sess = await openSess('dead-task-check');
      let leftover: number;
      try {
        const r = await sess.q<{ n: string }>(
          'dead_task_leftover',
          `SELECT count(*)::text AS n
             FROM meta.scan_task st
            WHERE st.kind <> 'confirm_deleted'
              AND NOT EXISTS (
                SELECT 1 FROM serve.page_current pc
                 WHERE pc.page_id = st.page_id AND pc.status = 'live')`,
        );
        leftover = Number(r[0]?.n ?? -1);
      } finally {
        await sess.end();
      }
      assert.equal(leftover, 0, '不应残留任何非 live 页面上的可清理任务');
    } finally {
      await pool.end().catch(() => undefined);
    }
  });
});

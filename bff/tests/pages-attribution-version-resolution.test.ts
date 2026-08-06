import express from 'express';
import request from 'supertest';
import type { Pool } from 'pg';
import { pagesRouter } from '../src/web/routes/pages';

/**
 * 回归测试：已删除页面的归属版本解析。
 *
 * Attribution 行只存在于单一 PageVersion 上，而 effectiveVersionId 对已删除页面会
 * 整体切到最近一个存活版本。生产库里两种错位同时存在：
 *   - 1642 个页面的归属只在墓碑版本（当前版）上 —— 用 effectiveVersionId 查会返回空
 *   - 869 个页面的归属只在存活版本上 —— 正是靠 effectiveVersionId 回退才正确
 * 因此任何固定口径都会错一半，必须按"数据实际所在版本"探测。
 */
describe('/pages/:wikidotId/attributions —— 已删除页面的归属版本解析', () => {
  const PAGE_ID = 101334;
  const TOMBSTONE_VER = 352948; // 当前版本（validTo IS NULL, isDeleted = true）
  const LIVE_VER = 352820; // 最近的存活版本（effectiveVersionId 会回退到它）

  const ATTRIBUTION_ROW = {
    userId: 13653,
    displayName: 'Hydroable Ivy',
    userWikidotId: 8421659,
    type: 'SUBMITTER',
    order: 0,
    date: '2025-11-30T16:00:00.000Z'
  };

  /**
   * @param versionHoldingAttributions 归属行实际挂在哪个版本上
   */
  function createApp(versionHoldingAttributions: number) {
    const attributionQueries: Array<{ sql: string; params: any[] }> = [];

    const queryMock = jest.fn(async (sql: string, params?: any[]) => {
      const text = String(sql);
      const args = Array.isArray(params) ? params : [];

      if (text.includes('FROM "Page" WHERE "wikidotId"')) {
        return { rows: [{ id: PAGE_ID }] };
      }
      if (text.includes('FROM "PageVersion"') && text.includes('"validTo" IS NULL')) {
        return { rows: [{ id: TOMBSTONE_VER, isDeleted: true }] };
      }
      if (text.includes('FROM "PageVersion"') && text.includes('"isDeleted" = false')) {
        return { rows: [{ id: LIVE_VER, isDeleted: false }] };
      }
      // 快路径：两次 EXISTS 探测，按 当前版本 > effective 版本 的优先级取第一个有归属的
      if (text.includes('WHEN EXISTS') && text.includes('"pageVerId" = $1::int')) {
        const hit = args.find((candidate) => candidate === versionHoldingAttributions);
        return { rows: [{ id: hit ?? null }] };
      }
      // 最终的归属查询
      if (text.includes('WITH attrs AS') && text.includes('FROM "Attribution" a')) {
        attributionQueries.push({ sql: text, params: args });
        return { rows: args[0] === versionHoldingAttributions ? [ATTRIBUTION_ROW] : [] };
      }
      return { rows: [] };
    });

    const pool: Partial<Pool> = { query: queryMock as unknown as Pool['query'] };
    const app = express();
    app.use('/pages', pagesRouter(pool as Pool, null));
    return { app, attributionQueries };
  }

  test('归属只在墓碑版本上时，用墓碑版本查询而不是回退后的存活版本', async () => {
    const { app, attributionQueries } = createApp(TOMBSTONE_VER);

    const res = await request(app).get('/pages/1467208209/attributions').expect(200);

    expect(res.body).toEqual([ATTRIBUTION_ROW]);
    expect(attributionQueries).toHaveLength(1);
    expect(attributionQueries[0].params[0]).toBe(TOMBSTONE_VER);
  });

  test('归属只在存活版本上时，仍然用回退后的存活版本查询（不得回归）', async () => {
    const { app, attributionQueries } = createApp(LIVE_VER);

    const res = await request(app).get('/pages/1467208209/attributions').expect(200);

    expect(res.body).toEqual([ATTRIBUTION_ROW]);
    expect(attributionQueries).toHaveLength(1);
    expect(attributionQueries[0].params[0]).toBe(LIVE_VER);
  });

  test('两个候选版本都没有归属时退回全版本扫描', async () => {
    const ORPHAN_VER = 340000;
    const scanned: string[] = [];

    const queryMock = jest.fn(async (sql: string, params?: any[]) => {
      const text = String(sql);
      const args = Array.isArray(params) ? params : [];

      if (text.includes('FROM "Page" WHERE "wikidotId"')) return { rows: [{ id: PAGE_ID }] };
      if (text.includes('FROM "PageVersion"') && text.includes('"validTo" IS NULL')) {
        return { rows: [{ id: TOMBSTONE_VER, isDeleted: true }] };
      }
      if (text.includes('FROM "PageVersion"') && text.includes('"isDeleted" = false')) {
        return { rows: [{ id: LIVE_VER, isDeleted: false }] };
      }
      if (text.includes('WHEN EXISTS') && text.includes('"pageVerId" = $1::int')) {
        return { rows: [{ id: null }] };
      }
      // 慢路径：从 PageVersion 侧驱动，找该 page 下任意有归属的最新版本
      if (text.includes('FROM "PageVersion" pv') && text.includes('EXISTS (SELECT 1 FROM "Attribution"')) {
        scanned.push(text);
        return { rows: [{ id: ORPHAN_VER }] };
      }
      if (text.includes('WITH attrs AS') && text.includes('FROM "Attribution" a')) {
        return { rows: args[0] === ORPHAN_VER ? [ATTRIBUTION_ROW] : [] };
      }
      return { rows: [] };
    });

    const pool: Partial<Pool> = { query: queryMock as unknown as Pool['query'] };
    const app = express();
    app.use('/pages', pagesRouter(pool as Pool, null));

    const res = await request(app).get('/pages/1467208209/attributions').expect(200);

    expect(scanned).toHaveLength(1);
    // 慢路径必须从 PageVersion 侧驱动：Attribution 表只有 6.8 万行，反过来写会让
    // planner 对版本数多的页面（最多 874 个版本）改走整表扫描。
    expect(scanned[0]).toContain('FROM "PageVersion" pv');
    expect(res.body).toEqual([ATTRIBUTION_ROW]);
  });
});

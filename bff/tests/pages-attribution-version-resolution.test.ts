import express from 'express';
import request from 'supertest';
import type { Pool } from 'pg';
import { pagesRouter } from '../src/web/routes/pages';

/**
 * 回归测试：已删除页面的归属版本解析。
 *
 * Attribution 挂在 pageVerId 上，而 effectiveVersionId 对已删除页面会整体切到最近一个
 * 存活版本。生产库里两种错位同时存在：
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

  // 用于区分"选中了哪个版本"：两个候选版本都持有归属时，两份行内容必须不同才能验证优先级
  const rowFor = (versionId: number) => ({ ...ATTRIBUTION_ROW, displayName: `author-of-${versionId}` });

  /**
   * @param versionsHoldingAttributions 哪些版本实际持有归属行
   */
  function createApp(versionsHoldingAttributions: number[]) {
    const attributionQueries: Array<{ sql: string; params: any[] }> = [];
    const holders = new Set(versionsHoldingAttributions);

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
      // 快路径：SQL 里是 CASE WHEN EXISTS($1) THEN $1 WHEN EXISTS($2) THEN $2。
      // 必须按**参数位置**依次判定而不是 args.find(...)，否则调换两个参数的顺序
      // （即把优先级反转）也能让测试通过，"当前版本优先"这条不变量就测不出来了。
      if (text.includes('WHEN EXISTS') && text.includes('"pageVerId" = $1::int')) {
        const hit = [args[0], args[1]].find((candidate) => candidate != null && holders.has(candidate));
        return { rows: [{ id: hit ?? null }] };
      }
      // 最终的归属查询
      if (text.includes('WITH attrs AS') && text.includes('FROM "Attribution" a')) {
        attributionQueries.push({ sql: text, params: args });
        return { rows: holders.has(args[0]) ? [rowFor(args[0])] : [] };
      }
      return { rows: [] };
    });

    const pool: Partial<Pool> = { query: queryMock as unknown as Pool['query'] };
    const app = express();
    app.use('/pages', pagesRouter(pool as Pool, null));
    return { app, attributionQueries };
  }

  test('归属只在墓碑版本上时，用墓碑版本查询而不是回退后的存活版本', async () => {
    const { app, attributionQueries } = createApp([TOMBSTONE_VER]);

    const res = await request(app).get('/pages/1467208209/attributions').expect(200);

    expect(res.body).toEqual([rowFor(TOMBSTONE_VER)]);
    expect(attributionQueries).toHaveLength(1);
    expect(attributionQueries[0].params[0]).toBe(TOMBSTONE_VER);
  });

  test('归属只在存活版本上时，仍然用回退后的存活版本查询（不得回归）', async () => {
    const { app, attributionQueries } = createApp([LIVE_VER]);

    const res = await request(app).get('/pages/1467208209/attributions').expect(200);

    expect(res.body).toEqual([rowFor(LIVE_VER)]);
    expect(attributionQueries).toHaveLength(1);
    expect(attributionQueries[0].params[0]).toBe(LIVE_VER);
  });

  // 这是"优先级 1 高于 2"这条不变量唯一可观测的场景：只有一边持有归属时，
  // 反转优先级的结果完全相同。全库 4355 个页面的归属分布在多个版本上，
  // per-version 归属是常态，所以这个分支随时可能出现在回退人群里。
  test('两个候选版本都持有归属时，选当前版本而不是回退后的存活版本', async () => {
    const { app, attributionQueries } = createApp([TOMBSTONE_VER, LIVE_VER]);

    const res = await request(app).get('/pages/1467208209/attributions').expect(200);

    expect(attributionQueries).toHaveLength(1);
    expect(attributionQueries[0].params[0]).toBe(TOMBSTONE_VER);
    expect(res.body).toEqual([rowFor(TOMBSTONE_VER)]);
  });

  // 刻意不去扫描更早的历史版本：AttributionService.importAttributions 在上游返回空列表时
  // 会 deleteMany 掉该版本的归属行，所以"两个候选版本都没有归属"可能是权威的
  // "这页确实没有作者"，而不是"行放错了地方"。扫历史版本会把两者混为一谈、复活已被主动
  // 移除的作者。这条用例把"不扫历史版本"这个决定钉住。
  test('两个候选版本都没有归属时返回空，不去翻更早的历史版本', async () => {
    const ORPHAN_VER = 340000; // 某个更早的版本上还留着归属行
    const extraQueries: string[] = [];

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
      if (text.includes('WITH attrs AS') && text.includes('FROM "Attribution" a')) {
        // 只有 ORPHAN_VER 上还有归属；被查到就说明翻了历史版本
        return { rows: args[0] === ORPHAN_VER ? [ATTRIBUTION_ROW] : [] };
      }
      // 任何为了找归属而扫 PageVersion 的查询都不该出现
      if (text.includes('FROM "PageVersion" pv') && text.includes('EXISTS (SELECT 1 FROM "Attribution"')) {
        extraQueries.push(text);
        return { rows: [{ id: ORPHAN_VER }] };
      }
      return { rows: [] };
    });

    const pool: Partial<Pool> = { query: queryMock as unknown as Pool['query'] };
    const app = express();
    app.use('/pages', pagesRouter(pool as Pool, null));

    const res = await request(app).get('/pages/1467208209/attributions').expect(200);

    expect(extraQueries).toHaveLength(0);
    expect(res.body).toEqual([]);
  });
});

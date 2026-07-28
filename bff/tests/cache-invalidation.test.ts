import { createCache } from '../src/web/utils/cache';

/**
 * 提醒列表的缓存键形如 alerts:{wikidotId}:{metric}:{limit}:{offset}，
 * 一次「标记已读」必须让该用户名下所有分页/指标组合一并失效。
 * 生产环境未配置 REDIS_URL，实际走的是内存缓存分支，因此这里重点覆盖它。
 */
describe('cache delByPrefix / del', () => {
  // isolatedMemory 避免污染其它测试共享的全局 memoryCache
  const makeCache = () => createCache(null, 'test:', { isolatedMemory: true });

  it('按前缀失效同一用户的全部缓存键，且不误伤其他用户', async () => {
    const cache = makeCache();

    await cache.setJSON('alerts:1546989:COMMENT_COUNT:20:0', { unreadCount: 3 }, 60);
    await cache.setJSON('alerts:1546989:VOTE_COUNT:50:20', { unreadCount: 1 }, 60);
    await cache.setJSON('alerts:1546989:REVISION_COUNT:20:0', { unreadCount: 7 }, 60);
    await cache.setJSON('alerts:999999:COMMENT_COUNT:20:0', { unreadCount: 2 }, 60);

    await cache.delByPrefix('alerts:1546989:');

    expect(await cache.getJSON('alerts:1546989:COMMENT_COUNT:20:0')).toBeNull();
    expect(await cache.getJSON('alerts:1546989:VOTE_COUNT:50:20')).toBeNull();
    expect(await cache.getJSON('alerts:1546989:REVISION_COUNT:20:0')).toBeNull();
    // 其他用户的缓存必须保留
    expect(await cache.getJSON('alerts:999999:COMMENT_COUNT:20:0')).toEqual({ unreadCount: 2 });
  });

  it('前缀失效后 remember 会重新执行 loader（未读数不再回弹）', async () => {
    const cache = makeCache();
    let unread = 3;
    const loader = jest.fn(async () => ({ unreadCount: unread }));

    const first = await cache.remember('alerts:1:COMMENT_COUNT:20:0', 60, loader);
    expect(first).toEqual({ unreadCount: 3 });

    // 未失效时应命中缓存，loader 不再执行
    unread = 0;
    const cached = await cache.remember('alerts:1:COMMENT_COUNT:20:0', 60, loader);
    expect(cached).toEqual({ unreadCount: 3 });
    expect(loader).toHaveBeenCalledTimes(1);

    // 标记已读 → 失效 → 下一次读到的是新值
    await cache.delByPrefix('alerts:1:');
    const fresh = await cache.remember('alerts:1:COMMENT_COUNT:20:0', 60, loader);
    expect(fresh).toEqual({ unreadCount: 0 });
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('del 只删单个 key', async () => {
    const cache = makeCache();
    await cache.setJSON('a:1', 1, 60);
    await cache.setJSON('a:2', 2, 60);

    await cache.del('a:1');

    expect(await cache.getJSON('a:1')).toBeNull();
    expect(await cache.getJSON('a:2')).toBe(2);
  });

  it('前缀不匹配时是无操作，且对不存在的 key 幂等', async () => {
    const cache = makeCache();
    await cache.setJSON('alerts:1:x', 1, 60);

    await cache.delByPrefix('alerts:2:');
    await cache.del('does-not-exist');

    expect(await cache.getJSON('alerts:1:x')).toBe(1);
  });

  it('失效会丢弃在途 loader，避免陈旧结果被写回', async () => {
    const cache = makeCache();
    let release: (v: { v: number }) => void = () => {};
    const slow = new Promise<{ v: number }>((resolve) => { release = resolve; });

    // 第一次 remember 挂起在 loader 中
    const pending = cache.remember('k', 60, () => slow);
    // 在 loader 返回前失效
    await cache.delByPrefix('k');
    // loader 完成
    release({ v: 1 });
    await pending;

    // 此时缓存里可能残留 loader 写入的旧值；再次失效后必须读不到
    await cache.delByPrefix('k');
    expect(await cache.getJSON('k')).toBeNull();
  });
});

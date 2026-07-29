/**
 * 跨库只读：从 user-backend 的库里取「活跃的 QQ 通知绑定」。
 *
 * 【为什么允许 backend 直连用户库】
 * 已有先例：cli/alerts.ts 用同样的 createRequire 方式加载 user-backend 的 Prisma client
 * 来读注册用户名单。**写入方向仍严格单一** —— 绑定的建立/撤销只由 user-backend 负责，
 * 这里只读。若将来要收紧成纯 HTTP 边界，把 loadActiveQqTargets 换成
 * `GET /internal/notifications/qq-targets` 即可，调用方无需改动。
 *
 * 【为什么要缓存】
 * dispatcher 每 60 秒跑一轮，而绑定关系分钟级别几乎不变。每轮重新建连接池、
 * 全表扫一遍是纯浪费；但缓存太久又会让「用户刚解绑却还收到推送」变成可能，
 * 所以 TTL 取 60 秒 —— 最坏一轮的延迟。
 */

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const USER_BACKEND_CLIENT_PATH = '../../../user-backend/node_modules/@prisma/client/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let userEnvLoaded = false;

function ensureUserBackendEnv(): void {
  if (userEnvLoaded) return;
  const candidate = path.resolve(__dirname, '../../../user-backend/.env');
  if (fs.existsSync(candidate)) {
    // 若当前值是空串（.env.example 抄来的空占位），override:false 不会替换它，
    // 先删掉再加载，让 user-backend/.env 里的真实值能生效。
    if (!(process.env.USER_DATABASE_URL || '').trim()) delete process.env.USER_DATABASE_URL;
    dotenv.config({ path: candidate, override: false });
  }
  userEnvLoaded = true;
}

export interface QqTarget {
  /** user-backend 的账号 id（cuid），仅用于日志与回报 */
  accountId: string;
  /**
   * 绑定行的不可变 id。回报投递结果时必须带上它 ——
   * 只按 (userId, channel) 定位的话，用户在缓存宽限期内解绑再重绑
   * （那是一行**新记录**），旧地址的失败就会被记到新绑定头上，
   * 甚至把一个健康的新绑定连累到自动暂停。
   */
  bindingId: string;
  /** 主库 User.wikidotId —— 跨库的唯一桥梁 */
  wikidotId: number;
  /** 完整 QQ 号。**只在本进程内存中出现，不落日志、不进 payload。** */
  address: string;
  /** 由三级偏好解析出的「事件类型 → 是否推送」矩阵；阶段 5 才会有值 */
  resolvedMatrix: Record<string, unknown> | null;
}

interface CacheEntry {
  targets: QqTarget[];
  at: number;
}

const CACHE_TTL_MS = 60_000;
let cache: CacheEntry | null = null;

/**
 * 读取所有可投递的 QQ 绑定。
 *
 * 过滤条件的含义：
 *  - status = ACTIVE：排除用户主动暂停（PAUSED）与已解绑（REVOKED）
 *  - linkedWikidotId 非空：所有告警表都按主库 User.id 索引，而 User 由 wikidotId 定义。
 *    没绑 Wikidot 的账号根本不存在任何告警，推给他们没有意义。
 *  - 账号 status = ACTIVE：停用账号不该继续收通知
 */
export async function loadActiveQqTargets(options: { force?: boolean } = {}): Promise<QqTarget[]> {
  if (!options.force && cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.targets;
  }

  ensureUserBackendEnv();
  // 用 trim() 判空：backend/.env 里若留了 `USER_DATABASE_URL=` 空占位，
  // dotenv 的 override:false 不会用 user-backend/.env 的真实值替换它，
  // 于是每轮都取不到目标却毫无线索。
  const userDbUrl = (process.env.USER_DATABASE_URL || '').trim()
    || (process.env.USER_BACKEND_DATABASE_URL || '').trim();
  if (!userDbUrl) {
    console.warn('[notify] USER_DATABASE_URL 未配置，无法读取 QQ 绑定，本轮跳过投递');
    return [];
  }

  const localRequire = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userBackendModule: any = localRequire(USER_BACKEND_CLIENT_PATH);
  const UserBackendPrismaClient = userBackendModule?.PrismaClient;
  if (typeof UserBackendPrismaClient !== 'function') {
    console.warn('[notify] 无法加载 user-backend 的 Prisma client，本轮跳过投递');
    return [];
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client: any = new UserBackendPrismaClient({ datasources: { db: { url: userDbUrl } } });
  try {
    const rows: Array<{
      id: string;
      address: string;
      resolvedMatrix: unknown;
      user: { id: string; linkedWikidotId: number | null; status: string };
    }> = await client.notificationChannelBinding.findMany({
      where: {
        channel: 'QQ',
        status: 'ACTIVE',
        user: { status: 'ACTIVE', linkedWikidotId: { not: null } }
      },
      select: {
        id: true,
        address: true,
        resolvedMatrix: true,
        user: { select: { id: true, linkedWikidotId: true, status: true } }
      }
    });

    const targets: QqTarget[] = [];
    for (const row of rows) {
      const wikidotId = row.user?.linkedWikidotId;
      if (typeof wikidotId !== 'number' || !Number.isFinite(wikidotId)) continue;
      targets.push({
        accountId: row.user.id,
        bindingId: row.id,
        wikidotId,
        address: row.address,
        resolvedMatrix: (row.resolvedMatrix as Record<string, unknown> | null) ?? null
      });
    }
    cache = { targets, at: Date.now() };
    return targets;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[notify] 读取 QQ 绑定失败：', message);
    // 短暂不可用时可以用上一份缓存兜一下，但**不能无限用下去** ——
    // 用户解绑后若用户库恰好长时间不可用，过期缓存会让我们一直往一个
    // 已撤销的 QQ 号发私信。超过一个宽限期就 fail closed（本轮不投递），
    // 宁可漏发也不能发给已经解绑的人。
    const GRACE_MS = CACHE_TTL_MS * 3;
    if (cache && Date.now() - cache.at < GRACE_MS) {
      console.warn('[notify] 用户库暂时不可用，沿用上一份绑定快照（宽限期内）');
      return cache.targets;
    }
    console.error('[notify] 用户库不可用且缓存已超出宽限期，本轮不投递任何人（fail closed）');
    return [];
  } finally {
    await client.$disconnect?.();
  }
}

export function invalidateTargetCache(): void {
  cache = null;
}

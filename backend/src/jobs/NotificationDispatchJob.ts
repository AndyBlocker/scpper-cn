/**
 * 站外通知投递器（当前只有 QQ 渠道）。
 *
 * 形态是**旁路扫描**而非事件推送：每轮按 24 小时回看窗口扫三张告警表，
 * 用 dedupeKey 比对 NotificationDelivery 剔除已推过的，聚合成一条摘要发出去。
 * 三个告警 producer 一行不改 —— 它们跑在 scpper-sync 的关键路径上，
 * 出问题停掉本进程即可完全回滚。
 *
 * 几条刻意的设计取舍：
 *  1. **每轮每人只发一条摘要**，不做逐条即时推送。QQ 对私聊频率有风控，
 *     而一次 sync 可能一口气产生上百条告警，逐条推等于主动送去封号。
 *  2. **不碰 acknowledgedAt**。已读状态属于站内通知的语义，推送不该顺手把它标掉，
 *     否则用户会发现「收到 QQ 提醒后站内红点就没了」。
 *  3. **冷启动闸门**。首次上线时库里已有约 3.5 万条历史告警，没有闸门就会
 *     一次性推给所有人。NOTIFY_DISPATCH_START_AT 之前的告警永不处理。
 */

import { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../utils/db-connection.js';
import { loadActiveQqTargets, type QqTarget } from '../services/userDirectory.js';
import { checkHealth, isPermanentFailure, pushQqMessage, EXPECTED_CONTRACT } from '../services/qqPush.js';

const LOOKBACK_HOURS = Math.max(1, Number(process.env.NOTIFY_LOOKBACK_HOURS ?? '24') || 24);
/** 单用户单轮上限：超出的合并为一句「还有 N 条」，避免一个人的告警风暴刷屏 */
const CIRCUIT_USER_MAX = Math.max(1, Number(process.env.NOTIFY_CIRCUIT_USER_MAX ?? '20') || 20);
/**
 * 全局单轮上限。必须有：`analyze --full` 或 AnalysisWatermark 丢失会让 changeSet
 * 退化为全库重算，单轮可能产生上万条告警。跳闸后需人工复位（--reset-circuit），
 * 因为进程重启就自愈的话，真正的问题还在。
 */
const CIRCUIT_GLOBAL_MAX = Math.max(1, Number(process.env.NOTIFY_CIRCUIT_GLOBAL_MAX ?? '2000') || 2000);
/** 单用户每日投递上限 */
const DAILY_LIMIT = Math.max(1, Number(process.env.NOTIFY_DAILY_LIMIT ?? '40') || 40);

const SITE_BASE = (process.env.NOTIFY_SITE_BASE || 'https://scp-cn.wiki').replace(/\/$/, '');

/**
 * 灰度名单：逗号分隔的 wikidotId。**未配置**才表示不限制。
 *
 * 关键区别：配了但一个都解析不出来（比如写成分号分隔、或全是拼错的值）时
 * 返回**空集合**而不是 null —— 原实现返回 null，调用方当成「不限制」，
 * 于是一个笔误就把灰度发布变成了全量群发。宁可一条不发也不能发错人。
 */
function parseAllowlist(): Set<number> | null {
  const raw = (process.env.NOTIFY_QQ_ALLOWLIST || '').trim();
  if (!raw) return null;
  const set = new Set<number>();
  for (const part of raw.split(',')) {
    const t = part.trim();
    if (!t) continue;
    // 必须整条都是正整数。parseInt('123abc') 会得到 123、parseInt('1e3') 得到 1，
    // 把畸形条目当成合法 wikidotId 意味着把私人通知推给一个无关的人。
    if (!/^[1-9][0-9]*$/.test(t)) {
      console.error(`[notify] NOTIFY_QQ_ALLOWLIST 含非法条目「${t}」，已忽略该条`);
      continue;
    }
    set.add(Number(t));
  }
  if (set.size === 0) {
    console.error('[notify] NOTIFY_QQ_ALLOWLIST 已配置但解析不出任何 wikidotId，本轮不投递任何人');
  }
  return set;
}

/**
 * 冷启动闸门。
 *
 * 两个要同时满足的目标：
 *  1. 首次上线不能把库里约 3.5 万条历史告警群发出去 —— 所以未配置时不能是「不限制」；
 *  2. 闸门**不能随每次重启前移** —— 否则投递器停机（部署、崩溃、熔断复位）期间
 *     产生的告警会落到窗口之外，既不重试也不记录，等于静默丢失。
 *
 * 做法：首轮把闸门值落库（NotificationDispatchState.cutoffAt），之后一律读库里的。
 * 显式配置了 NOTIFY_DISPATCH_START_AT 时以环境变量为准并同步回库，
 * 便于运维需要时前移或回拨。
 */
async function resolveCutoff(prisma: PrismaClient, persisted: Date | null): Promise<Date> {
  const raw = (process.env.NOTIFY_DISPATCH_START_AT || '').trim();
  if (raw) {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) {
      if (!persisted || persisted.getTime() !== parsed.getTime()) {
        await prisma.notificationDispatchState.update({ where: { id: 1 }, data: { cutoffAt: parsed } });
      }
      return parsed;
    }
    console.warn(`[notify] NOTIFY_DISPATCH_START_AT 无法解析（${raw}），改用已落库的闸门`);
  }
  if (persisted) return persisted;
  // 首次运行且未显式配置：落一个进程启动时刻，此后不再变动
  await prisma.notificationDispatchState.update({ where: { id: 1 }, data: { cutoffAt: PROCESS_START } });
  console.warn(
    `[notify] 未配置 NOTIFY_DISPATCH_START_AT，已把冷启动闸门固定为 ${PROCESS_START.toISOString()} 并落库。`
    + ' 如需调整请设置该环境变量。'
  );
  return PROCESS_START;
}

const PROCESS_START = new Date();

/**
 * 本次进程的运行标识，写进 payload.runId。
 * 用于「部分抢占后退让」时只删自己登记的占位 —— 无差别删除会把胜出方的
 * 占位也删掉，胜出方随后发送成功却更新到 0 行，那批候选于是又变回可投递，
 * 稍后会被重复发送。
 */
const RUN_ID = `${process.pid}-${PROCESS_START.getTime()}`;

interface Candidate {
  source: 'page_metric' | 'follow_activity' | 'forum';
  dedupeKey: string;
  userId: number;
  detectedAt: Date;
  line: string;
}

type Row = Record<string, unknown>;

function pageUrl(row: Row): string {
  const url = row.pageUrl ? String(row.pageUrl) : '';
  if (url.startsWith('http')) return url;
  const wid = row.pageWikidotId;
  return wid ? `${SITE_BASE}/page/${wid}` : SITE_BASE;
}

function pageLabel(row: Row): string {
  const title = row.pageTitle ? String(row.pageTitle) : '';
  const alt = row.pageAlternateTitle ? String(row.pageAlternateTitle) : '';
  if (title && alt) return `${title}（${alt}）`;
  return title || alt || String(row.pageUrl ?? '未知页面');
}

const METRIC_LABEL: Record<string, string> = {
  COMMENT_COUNT: '评论',
  VOTE_COUNT: '投票',
  REVISION_COUNT: '编辑'
};

export interface DispatchOptions {
  dryRun?: boolean;
  resetCircuit?: boolean;
}

export interface DispatchSummary {
  targets: number;
  candidates: number;
  sent: number;
  suppressed: number;
  failed: number;
  circuitTripped: boolean;
  skippedReason?: string;
}

export async function runNotificationDispatch(options: DispatchOptions = {}): Promise<DispatchSummary> {
  const prisma = getPrismaClient();
  const summary: DispatchSummary = {
    targets: 0, candidates: 0, sent: 0, suppressed: 0, failed: 0, circuitTripped: false
  };

  if (options.resetCircuit) {
    await prisma.notificationDispatchState.update({
      where: { id: 1 },
      data: { circuitTrippedAt: null, circuitReason: null }
    });
    console.log('[notify] 全局熔断已人工复位');
  }

  const state = await prisma.notificationDispatchState.upsert({
    where: { id: 1 },
    create: { id: 1 },
    update: { lastRunAt: new Date() }
  });
  if (state.circuitTrippedAt && !options.resetCircuit) {
    summary.skippedReason = `全局熔断于 ${state.circuitTrippedAt.toISOString()} 跳闸（${state.circuitReason ?? '未知原因'}），需 notify-dispatch --reset-circuit 复位`;
    console.warn(`[notify] ${summary.skippedReason}`);
    summary.circuitTripped = true;
    return summary;
  }

  const targets = await loadActiveQqTargets();
  const allowlist = parseAllowlist();
  const effective = allowlist ? targets.filter((t) => allowlist.has(t.wikidotId)) : targets;
  summary.targets = effective.length;
  if (effective.length === 0) {
    return summary;
  }

  // wikidotId → 主库 User.id。所有告警表按 User.id 索引，而绑定侧只有 wikidotId。
  const wikidotIds = effective.map((t) => t.wikidotId);
  const users = await prisma.user.findMany({
    where: { wikidotId: { in: wikidotIds } },
    select: { id: true, wikidotId: true }
  });
  const byWikidotId = new Map<number, number>();
  for (const u of users) {
    if (u.wikidotId != null) byWikidotId.set(u.wikidotId, u.id);
  }
  const targetByUserId = new Map<number, QqTarget>();
  for (const t of effective) {
    const uid = byWikidotId.get(t.wikidotId);
    if (uid != null) targetByUserId.set(uid, t);
  }
  const userIds = [...targetByUserId.keys()];
  if (userIds.length === 0) return summary;

  const since = new Date(Date.now() - LOOKBACK_HOURS * 3600 * 1000);
  const startAt = await resolveCutoff(prisma, state.cutoffAt ?? null);
  // 取两者更晚的：冷启动闸门优先于回看窗口
  const floor = since > startAt ? since : startAt;

  // 清理崩溃遗留的占位：进程若在「占位」与「转终态」之间退出，那批 PENDING
  // 会永久挡住这些候选。超过 10 分钟仍是 PENDING 的一定是这种情况（正常路径是秒级）。
  const staleCutoff = new Date(Date.now() - 10 * 60 * 1000);
  const stale = await prisma.notificationDelivery.deleteMany({
    where: { state: 'PENDING', createdAt: { lt: staleCutoff } }
  });
  if (stale.count > 0) {
    console.warn(`[notify] 清理了 ${stale.count} 条陈旧 PENDING 占位（上一轮异常退出），这些候选将重新入选`);
  }

  const candidates = await collectCandidates(prisma, userIds, floor);
  summary.candidates = candidates.length;
  if (candidates.length === 0) {
    await prisma.notificationDispatchState.update({
      where: { id: 1 }, data: { lastSuccessAt: new Date() }
    });
    return summary;
  }

  if (candidates.length > CIRCUIT_GLOBAL_MAX) {
    const reason = `单轮候选 ${candidates.length} 条超过全局上限 ${CIRCUIT_GLOBAL_MAX}`;
    if (options.resetCircuit) {
      // --reset-circuit 时必须**消化掉**触发跳闸的那批积压，否则复位后立刻重新扫到
      // 同一批候选、再次跳闸 —— 熔断从此永远恢复不了，除非等它们过了回看窗口
      // 或运维手动改上限。这里把它们标成 SUPPRESSED（不是失败，是主动放弃），
      // 并把闸门推进到最新一条之后，让下一轮从干净状态开始。
      const newest = candidates.reduce((a, c) => (c.detectedAt > a ? c.detectedAt : a), candidates[0].detectedAt);
      const byUser = new Map<number, Candidate[]>();
      for (const c of candidates) {
        const list = byUser.get(c.userId) ?? [];
        list.push(c);
        byUser.set(c.userId, list);
      }
      for (const [uid, items] of byUser) {
        await recordAll(prisma, items, uid, 'SUPPRESSED', 'circuit_reset_drop', false);
      }
      await prisma.notificationDispatchState.update({
        where: { id: 1 },
        data: { cutoffAt: newest, circuitTrippedAt: null, circuitReason: null }
      });
      summary.suppressed += candidates.length;
      console.warn(
        `[notify] 复位时消化了 ${candidates.length} 条积压（标记 SUPPRESSED，不会发送），`
        + `闸门推进到 ${newest.toISOString()}。下一轮起恢复正常投递。`
      );
      return summary;
    }
    console.error(`[notify] 全局熔断跳闸：${reason}。本轮不发送任何消息。`);
    console.error('[notify] 复位方式：notify-dispatch --once --reset-circuit（会把这批积压标记为已抑制，不补发）');
    await prisma.notificationDispatchState.update({
      where: { id: 1 },
      data: { circuitTrippedAt: new Date(), circuitReason: reason }
    });
    summary.circuitTripped = true;
    return summary;
  }

  // 健康检查放在有候选之后：没东西可发时不必打扰机器人。
  // dry-run 跳过这一步 —— 演练的意义正是在机器人不可用（或还没配好）时也能验证
  // 扫描、去重、聚合与文案，卡在健康检查上就失去了作用。
  if (!options.dryRun) {
    const health = await checkHealth();
    if (!health.ok) {
      console.warn('[notify] qqbot 不可用，本轮跳过（候选留待下轮，不落 FAILED）');
      summary.skippedReason = 'bot_unavailable';
      return summary;
    }
    if (health.contract && health.contract !== EXPECTED_CONTRACT) {
      console.warn(`[notify] 契约版本不一致：qqbot=${health.contract} 期望=${EXPECTED_CONTRACT}`);
    }
  }

  // 按用户分组
  const grouped = new Map<number, Candidate[]>();
  for (const c of candidates) {
    const list = grouped.get(c.userId) ?? [];
    list.push(c);
    grouped.set(c.userId, list);
  }

  for (const [userId, group] of grouped) {
    let items = group;
    const target = targetByUserId.get(userId);
    if (!target) continue;

    // 日限额
    const dayAgo = new Date(Date.now() - 24 * 3600 * 1000);
    const sentToday = await prisma.notificationDelivery.count({
      where: { userId, state: 'SENT', createdAt: { gt: dayAgo } }
    });
    const remaining = DAILY_LIMIT - sentToday;
    if (remaining <= 0) {
      await recordAll(prisma, items, userId, 'SUPPRESSED', 'daily_limit', options.dryRun);
      summary.suppressed += items.length;
      continue;
    }

    items.sort((a, b) => a.detectedAt.getTime() - b.detectedAt.getTime());
    // 限额要作用到**本批**：原先只在批前比一次，39 条已发 + 20 条新批会直接超到 59。
    // 超出配额的部分标记 SUPPRESSED，不发也不再重试。
    if (items.length > remaining) {
      const overflowItems = items.slice(remaining);
      await recordAll(prisma, overflowItems, userId, 'SUPPRESSED', 'daily_limit', options.dryRun);
      summary.suppressed += overflowItems.length;
      items = items.slice(0, remaining);
    }
    const shown = items.slice(0, CIRCUIT_USER_MAX);
    const overflow = items.length - shown.length;
    const message = renderDigest(shown, overflow);

    if (options.dryRun) {
      console.log(`[notify][dry-run] → ${target.wikidotId}（${items.length} 条）\n${message}\n`);
      summary.sent += items.length;
      continue;
    }

    // 发送**之前**先把这批 dedupeKey 以 PENDING 占住。
    // 原先是先发后记账：若机器人已经收下但响应丢失、或进程在 recordAll 前退出，
    // 这批候选下轮仍会被扫到，等机器人那 15 分钟去重窗口一过就会重复推送给用户。
    const keys = items.map((c) => c.dedupeKey);
    // createMany 的 skipDuplicates 会静默跳过别人已抢到的 key，但**不会**告诉我们跳了哪些。
    // 手动 PM2 轮次与 --once 手工轮次重叠时，两边都可能扫到同一批候选，
    // 输的那一方仍会把完整摘要发出去 → 用户收到两条一样的消息。
    // 这里比对「插入前后本轮 key 的归属」，只在确实是自己抢到时才发送。
    const claimed = await recordAll(prisma, items, userId, 'PENDING', null, false);
    if (claimed < items.length) {
      // 部分抢占：另一轮已经占住其中一些 key。此时若照发整批摘要，
      // 被对方占住的那几条就会被发两次。撤掉自己这部分占位、整批退让，
      // 下一轮由唯一的胜出者完整处理。
      await prisma.notificationDelivery.deleteMany({
        where: { dedupeKey: { in: keys }, state: 'PENDING', payload: { path: ['runId'], equals: RUN_ID } }
      });
      console.warn(
        `[notify] 用户 ${target.wikidotId} 的候选被另一轮部分抢占`
        + `（${claimed}/${items.length}），本轮整批退让`
      );
      continue;
    }

    const dedupeKey = `digest:${userId}:${shown[shown.length - 1].dedupeKey}`;
    const result = await pushQqMessage({ qq: target.address, message, dedupeKey });

    if (result.ok) {
      await prisma.notificationDelivery.updateMany({
        where: { dedupeKey: { in: keys }, state: 'PENDING', payload: { path: ['runId'], equals: RUN_ID } },
        data: { state: 'SENT', sentAt: new Date(), lastError: null }
      });
      summary.sent += items.length;
      // 成功要清零 failureCount，否则一次永久失败之后，日后**不连续**的偶发失败
      // 会累加到阈值，把一个正常渠道误暂停。
      await reportChannelOutcome(target.accountId, 'sent', null);
    } else if (isPermanentFailure(result.error)) {
      await prisma.notificationDelivery.updateMany({
        where: { dedupeKey: { in: keys }, state: 'PENDING', payload: { path: ['runId'], equals: RUN_ID } },
        data: { state: 'FAILED', lastError: result.error ?? 'unknown' }
      });
      summary.failed += items.length;
      console.warn(`[notify] 用户 ${target.wikidotId} 永久失败：${result.error}（不再重试）`);
      // 把永久失败回报给绑定方。不报的话：绑定一直是 ACTIVE、界面显示健康，
      // 而每条新告警都有新的 dedupeKey，于是对着一个已经删了机器人的用户永远重试下去。
      await reportChannelOutcome(target.accountId, 'failed', result.error ?? 'unknown');
    } else {
      // 可重试：撤销刚才的占位，让候选下轮重新被扫到。
      // 留着 PENDING 会让 dedupeKey 把重试也挡掉。
      await prisma.notificationDelivery.deleteMany({
        where: { dedupeKey: { in: keys }, state: 'PENDING', payload: { path: ['runId'], equals: RUN_ID } }
      });
      summary.failed += items.length;
      console.warn(`[notify] 用户 ${target.wikidotId} 暂时失败：${result.error}（下轮重试）`);
    }
  }

  await prisma.notificationDispatchState.update({
    where: { id: 1 }, data: { lastSuccessAt: new Date() }
  });
  return summary;
}

/**
 * 向 user-backend 回报渠道投递失败，由它累计 failureCount 并在阈值处暂停渠道。
 * 失败只记日志不抛 —— 回报不上不该影响本轮其余用户的投递。
 */
let warnedMissingNotifyKey = false;

async function reportChannelOutcome(
  accountId: string,
  outcome: 'sent' | 'failed',
  code: string | null
): Promise<void> {
  const base = (process.env.USER_BACKEND_BASE_URL || 'http://127.0.0.1:4455').replace(/\/$/, '');
  const key = (process.env.NOTIFY_INTERNAL_KEY || '').trim();
  if (!key) {
    // 静默跳过等于「渠道健康度永远不更新、坏掉的绑定永远不会自动暂停」。
    // 至少要吵一次，别让漏配变成看不见的功能缺失。
    if (!warnedMissingNotifyKey) {
      warnedMissingNotifyKey = true;
      console.error('[notify] 未配置 NOTIFY_INTERNAL_KEY —— 渠道健康度不会更新，失效绑定不会自动暂停');
    }
    return;
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const response = await fetch(`${base}/internal/notifications/report-delivery`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'x-internal-key': key },
        // code 为 null 时必须**省略**该字段：接收侧 schema 是 z.string().optional()，
        // 传 null 会 400
        body: JSON.stringify({ accountId, channel: 'QQ', outcome, ...(code ? { code } : {}) })
      });
      // fetch 对 4xx/5xx 也会 resolve。不查状态的话，密钥不一致（403）或
      // 参数不合（400）都会被当成回报成功 —— failureCount 既不累加也不清零，
      // 失效渠道永远不会自动暂停，而且毫无线索。
      if (!response.ok) {
        console.warn(
          `[notify] 回报渠道状态被拒（${response.status}）：${await response.text().catch(() => '')}`
        );
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    console.warn('[notify] 回报渠道状态失败：', error instanceof Error ? error.message : error);
  }
}

async function recordAll(
  prisma: PrismaClient,
  items: Candidate[],
  userId: number,
  state: 'PENDING' | 'SENT' | 'FAILED' | 'SUPPRESSED',
  error: string | null,
  dryRun?: boolean
): Promise<number> {
  if (dryRun) return 0;
  const now = new Date();
  const created = await prisma.notificationDelivery.createMany({
    data: items.map((c) => ({
      userId,
      channel: 'QQ' as const,
      dedupeKey: c.dedupeKey,
      state,
      attemptCount: 1,
      lastError: error,
      sentAt: state === 'SENT' ? now : null,
      payload: { source: c.source, line: c.line, detectedAt: c.detectedAt.toISOString(), runId: RUN_ID }
    })),
    skipDuplicates: true
  });
  return created.count;
}

function renderDigest(items: Candidate[], overflow: number): string {
  const lines = ['【SCPper CN】你有新的站点动态：', ''];
  for (const c of items) lines.push(`· ${c.line}`);
  if (overflow > 0) lines.push(`· …另有 ${overflow} 条`);
  lines.push('', `查看全部：${SITE_BASE}/account?tab=alerts`);
  return lines.join('\n');
}

/**
 * 扫三张告警表，剔除已推过的，得到本轮候选。
 *
 * 【为什么去重在 TS 里做而不是写进 SQL 的 NOT EXISTS】
 * 最初的写法是在 SQL 里拼 dedupeKey 再反连接。实测发现两侧对 double precision
 * 的文本化不一致：PostgreSQL 的 `1e20::text` 是 `1e+20`，而 JS 的
 * `String(1e20)` 是 `100000000000000000000`。键一旦对不上，反连接就永远命中不了，
 * 症状是**同一条通知每分钟重复推送** —— 最糟的失败模式。
 * 现在 dedupeKey 只由 TS 构造一次，SQL 完全不参与，不存在两套渲染规则。
 *
 * 【为什么不用「先插入靠唯一键冲突」去重】
 * 那样每轮都会为已推过的候选消耗一次序列值 —— 正是 UserTagPreference
 * int4 序列在半年内耗尽的成因。
 */
async function collectCandidates(
  prisma: PrismaClient,
  userIds: number[],
  since: Date
): Promise<Candidate[]> {
  const out: Candidate[] = [];

  // ① 页面指标告警：我的作品被评论/被投票/被他人修订
  const metricRows = await prisma.$queryRaw<Row[]>`
    SELECT pa.id, pa.metric::text AS metric, pa."newValue", pa."diffValue", pa."detectedAt",
           pw."userId", p."wikidotId" AS "pageWikidotId", p."currentUrl" AS "pageUrl",
           pv.title AS "pageTitle", pv."alternateTitle" AS "pageAlternateTitle"
    FROM "PageMetricAlert" pa
    JOIN "PageMetricWatch" pw ON pw.id = pa."watchId"
    JOIN "Page" p ON p.id = pa."pageId"
    LEFT JOIN "PageVersion" pv ON pv."pageId" = pa."pageId" AND pv."validTo" IS NULL
    WHERE pw."userId" = ANY(${userIds}::int[])
      AND pa."detectedAt" > ${since}
      AND pa."acknowledgedAt" IS NULL
    ORDER BY pa."detectedAt"
  `;
  for (const r of metricRows) {
    const metric = String(r.metric);
    const label = METRIC_LABEL[metric] ?? metric;
    const diff = r.diffValue != null ? Number(r.diffValue) : null;
    const delta = diff != null ? `${diff > 0 ? '+' : ''}${diff}` : '';
    out.push({
      source: 'page_metric',
      // 键里带 detectedAt：PageMetricAlert 是就地更新的，只带 newValue 的话
      // 「20→40→20→40」这种来回变动，最后那次 40 会撞到早先 40 的键而被当成已投递。
      dedupeKey: `pma:${r.id}:${r.newValue ?? 'n'}:${new Date(String(r.detectedAt)).getTime()}`,
      userId: Number(r.userId),
      detectedAt: new Date(String(r.detectedAt)),
      line: `你的《${pageLabel(r)}》${label}有变化 ${delta}  ${pageUrl(r)}`
    });
  }

  // ② 关注作者动态
  const followRows = await prisma.$queryRaw<Row[]>`
    SELECT ua.id, ua.type, ua."detectedAt", ua."followerId", ua."revisionId", ua."pageVersionId",
           p."wikidotId" AS "pageWikidotId", p."currentUrl" AS "pageUrl",
           pv.title AS "pageTitle", pv."alternateTitle" AS "pageAlternateTitle",
           tu."displayName" AS "targetName"
    FROM "UserActivityAlert" ua
    JOIN "Page" p ON p.id = ua."pageId"
    LEFT JOIN "PageVersion" pv ON pv."pageId" = ua."pageId" AND pv."validTo" IS NULL
    LEFT JOIN "User" tu ON tu.id = ua."targetUserId"
    WHERE ua."followerId" = ANY(${userIds}::int[])
      AND ua."detectedAt" > ${since}
      AND ua."acknowledgedAt" IS NULL
    ORDER BY ua."detectedAt"
  `;
  for (const r of followRows) {
    const who = r.targetName ? String(r.targetName) : '你关注的作者';
    const what = String(r.type) === 'REVISION' ? '编辑了' : String(r.type) === 'ATTRIBUTION' ? '发布了' : '不再署名';
    out.push({
      source: 'follow_activity',
      dedupeKey: `uaa:${r.id}:${r.revisionId ?? r.pageVersionId ?? 'n'}`,
      userId: Number(r.followerId),
      detectedAt: new Date(String(r.detectedAt)),
      line: `${who} ${what}《${pageLabel(r)}》  ${pageUrl(r)}`
    });
  }

  // ③ 论坛互动（回帖 / 直接回复 / @我）
  const forumRows = await prisma.$queryRaw<Row[]>`
    SELECT fa.id, fa.type::text AS type, fa."detectedAt", fa."recipientUserId",
           fa."actorName", fa."postTitle", fa."postExcerpt", fa."threadId"
    FROM "ForumInteractionAlert" fa
    WHERE fa."recipientUserId" = ANY(${userIds}::int[])
      AND fa."detectedAt" > ${since}
      AND fa."acknowledgedAt" IS NULL
    ORDER BY fa."detectedAt"
  `;
  for (const r of forumRows) {
    const actor = r.actorName ? String(r.actorName) : '有人';
    const type = String(r.type);
    const verb = type === 'MENTION' ? '提到了你' : type === 'DIRECT_REPLY' ? '回复了你' : '在你关注的讨论中发言';
    const title = r.postTitle ? `「${String(r.postTitle)}」` : '';
    out.push({
      source: 'forum',
      dedupeKey: `fia:${r.id}`,
      userId: Number(r.recipientUserId),
      detectedAt: new Date(String(r.detectedAt)),
      line: `${actor} ${verb} ${title}`.trim()
    });
  }

  if (out.length === 0) return out;

  // 一次查出这批 key 里已经存在的，再在内存里剔除。
  // 只按 dedupeKey 唯一索引等值查询，与候选数同阶，不随投递表总量增长。
  const seen = new Set<string>();
  const keys = out.map((c) => c.dedupeKey);
  const CHUNK = 1000;
  for (let i = 0; i < keys.length; i += CHUNK) {
    const existing = await prisma.notificationDelivery.findMany({
      where: { dedupeKey: { in: keys.slice(i, i + CHUNK) } },
      select: { dedupeKey: true }
    });
    for (const row of existing) seen.add(row.dedupeKey);
  }
  return out.filter((c) => !seen.has(c.dedupeKey));
}

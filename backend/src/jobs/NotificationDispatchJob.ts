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

import { Prisma, PrismaClient } from '@prisma/client';
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

/**
 * 摘要里「查看全部」指向的站点。必须是 **SCPper 前端**的域名，
 * 因为 /account 这个页面由前端提供 —— 默认值原先写的是 scp-cn.wiki
 * （SCP 中文站本身），链接过去只会是一个不存在的页面。
 */
const SITE_BASE = (process.env.NOTIFY_SITE_BASE || 'https://scpper.mer.run').replace(/\/$/, '');

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
async function resolveCutoff(prisma: PrismaClient, persisted: Date | null, dryRun = false): Promise<Date> {
  const raw = (process.env.NOTIFY_DISPATCH_START_AT || '').trim();
  if (raw) {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) {
      if (!persisted || persisted.getTime() !== parsed.getTime()) {
        // 演练不得改动闸门：它决定真实投递器会跳过哪些历史告警，
        // 一次「只看看」的命令把它写死，影响会一直留在生产上。
        if (dryRun) {
          console.warn(`[notify][dry-run] 闸门将被写为 ${parsed.toISOString()}（本次未写入）`);
        } else {
          await prisma.notificationDispatchState.update({ where: { id: 1 }, data: { cutoffAt: parsed } });
        }
      }
      return parsed;
    }
    console.warn(`[notify] NOTIFY_DISPATCH_START_AT 无法解析（${raw}），改用已落库的闸门`);
  }
  if (persisted) return persisted;
  // 首次运行且未显式配置：落一个进程启动时刻，此后不再变动
  if (dryRun) {
    console.warn(
      `[notify][dry-run] 尚未落库过冷启动闸门；真实运行会把它固定为进程启动时刻`
      + `（本次按 ${PROCESS_START.toISOString()} 试算，未写入）。`
    );
    return PROCESS_START;
  }
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

/** 与 UserNotificationPreference.type 对齐的通知类型 */
type NotifyType = 'PAGE_COMMENT' | 'PAGE_VOTE' | 'PAGE_REVISION' | 'FOLLOW_ACTIVITY' | 'FORUM_INTERACTION';

/** 页面指标 → 通知类型 */
const METRIC_TO_TYPE: Record<string, NotifyType> = {
  COMMENT_COUNT: 'PAGE_COMMENT',
  VOTE_COUNT: 'PAGE_VOTE',
  REVISION_COUNT: 'PAGE_REVISION'
};

interface Candidate {
  source: 'page_metric' | 'follow_activity' | 'forum';
  /** 用于按用户偏好过滤 QQ 推送 */
  notifyType: NotifyType;
  dedupeKey: string;
  userId: number;
  detectedAt: Date;
  line: string;
  /**
   * 合并键。同一页面的多条指标变动、同一话题的多条回复会被并成一行 ——
   * 一次推送里把同一个页面列三遍（评论 +2 / 投票 +5 / 编辑 +1）
   * 既占篇幅又难读。
   */
  groupKey: string;
  /** 组头，如「你的《SCP-CN-1000》」。仅当组内可拼接时提供。 */
  mergeHead?: string;
  /** 组内片段，如「投票 +12」。同组的片段用「、」连起来。 */
  mergePart?: string;
  /** 组尾（页面链接） */
  mergeTail?: string;
}

/** 渲染合并所需的最小信息。重发时从 payload 还原出来的也是这个形状。 */
interface MergeItem {
  line: string;
  groupKey?: string;
  mergeHead?: string;
  mergePart?: string;
  mergeTail?: string;
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
  /**
   * 是否已收到停止信号。返回 true 时**不再开始新的收件人**，
   * 但当前这一条正在进行的原子投递（占位 → 发送 → 记账）一定跑完。
   *
   * 关停屏障若傻等整轮，多收件人的一轮可能超过 15 秒超时上限，
   * 超时后进程照退，反而在某个后续收件人发送到一半时被砍断 ——
   * 恰好是屏障要防的那件事。粒度必须落到单次投递。
   */
  shouldStop?: () => boolean;
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
    // 这里是**最先**执行的一处熔断写操作，必须自己带 dry-run 判断 ——
    // 后面那些分支的 dry-run 守卫根本轮不到执行。
    // 漏掉的后果很实在：运维用 `--once --dry-run --reset-circuit` 想「看看复位会发生什么」，
    // 结果熔断真被清掉，常驻的 PM2 投递器下一轮就开始把积压发出去。
    if (options.dryRun) {
      console.warn('[notify][dry-run] --reset-circuit 未执行：真实运行会清除熔断状态并恢复投递');
    } else {
      await prisma.notificationDispatchState.update({
        where: { id: 1 },
        data: { circuitTrippedAt: null, circuitReason: null }
      });
      console.log('[notify] 全局熔断已人工复位');
    }
  }

  const state = await prisma.notificationDispatchState.upsert({
    where: { id: 1 },
    create: { id: 1 },
    // 演练不推进 lastRunAt：notify-inspect 用它判断投递器是否还活着，
    // 让一次演练把「其实已经停了」伪装成「刚跑过」是帮倒忙。
    update: options.dryRun ? {} : { lastRunAt: new Date() }
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
    // 一个目标都没有（全被暂停/解绑/挡在灰度名单外）时也必须跑一次清理：
    // 否则残留的 SCHEDULED 行永远不会过期，等某个目标日后重新启用，
    // 那批陈年批次会被当成待重发原样送出去。
    await expireStaleScheduledBatches(prisma, Boolean(options.dryRun));
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
  /**
   * 发送前复验绑定是否仍然有效。
   *
   * 目标快照是**整轮开始时**取的一份，但一轮可能很长：单轮上限 2000 条候选、
   * 每次推送最多等 5 秒，收件人又是串行处理的。排在后面的收件人真正被发送时，
   * 这份快照可能已经过期很久 —— 期间用户解绑或渠道被自动暂停，
   * 他仍会收到通知。这属于「已经撤销授权却还在收消息」，不只是数据不新。
   *
   * 快照超过 TTL 就重取一次，并确认该收件人的绑定身份没变；
   * 身份变了（重绑）或已不在列表里（解绑/暂停）就跳过，不占用重试次数。
   *
   * 【重取后必须刷新时间戳并缓存结果】
   * 否则 targetsLoadedAt 永远停在轮次开始时刻，超过 60 秒后**每个**收件人
   * 都会触发一次 loadActiveQqTargets({force:true}) —— 那是建 Prisma 连接、
   * 全表扫活跃绑定、再断开的一整套跨库操作。一轮几百个收件人就是几百次全量扫描，
   * 越忙的投递器越追不上进度。刷新时间戳后，一次重取覆盖之后一整个 TTL 窗口。
   */
  const TARGET_SNAPSHOT_TTL_MS = 60_000;
  let targetsLoadedAt = Date.now();
  let freshByBindingId: Map<string, QqTarget> | null = null;

  const revalidateTarget = async (t: QqTarget): Promise<QqTarget | null> => {
    if (Date.now() - targetsLoadedAt < TARGET_SNAPSHOT_TTL_MS) {
      // 仍在有效期内：若上次重取过，以那份更新的为准
      return freshByBindingId ? (freshByBindingId.get(t.bindingId) ?? null) : t;
    }
    const fresh = await loadActiveQqTargets({ force: true });
    freshByBindingId = new Map(fresh.map((x) => [x.bindingId, x]));
    targetsLoadedAt = Date.now();
    const still = freshByBindingId.get(t.bindingId);
    if (!still || still.address !== t.address) {
      console.warn(`[notify] 用户 ${t.wikidotId} 的绑定在本轮进行中已失效（解绑/暂停/重绑），跳过`);
      return null;
    }
    return still;
  };

  const userIds = [...targetByUserId.keys()];
  if (userIds.length === 0) {
    await expireStaleScheduledBatches(prisma, Boolean(options.dryRun));
    return summary;
  }

  const since = new Date(Date.now() - LOOKBACK_HOURS * 3600 * 1000);
  const startAt = await resolveCutoff(prisma, state.cutoffAt ?? null, options.dryRun);
  // 取两者更晚的：冷启动闸门优先于回看窗口
  const floor = since > startAt ? since : startAt;

  // 清理崩溃遗留的占位：进程若在「占位」与「转终态」之间退出，那批 PENDING
  // 会永久挡住这些候选。超过 10 分钟仍是 PENDING 的一定是这种情况（正常路径是秒级）。
  // 演练只报数不删：删掉的是真实投递器的占位，可能让它把同一批重发一次。
  const staleCutoff = new Date(Date.now() - 10 * 60 * 1000);
  if (options.dryRun) {
    const staleCount = await prisma.notificationDelivery.count({
      where: { state: 'PENDING', createdAt: { lt: staleCutoff } }
    });
    if (staleCount > 0) console.warn(`[notify][dry-run] 有 ${staleCount} 条陈旧 PENDING 占位，真实运行会清理它们`);
  } else {
    // 转 SCHEDULED 而不是删掉。
    //
    // 这些占位来自「机器人可能已经收下、进程却在记账前挂了」的场景。
    // 删掉的话原始 digestKey 一并没了，下轮重新组批 —— 期间只要来一条新告警，
    // 摘要就多一行、key 随之改变，等机器人 15 分钟去重窗口一过，
    // 同样那几行会被再推一遍。保留原批次与原 key 才能让重发真正幂等。
    // 没有 digestKey 的（更早版本写入的）保持删除，它们本来就重建不出原消息。
    const staleWithDigest = await prisma.notificationDelivery.updateMany({
      where: {
        state: 'PENDING',
        createdAt: { lt: staleCutoff },
        NOT: { payload: { path: ['digestKey'], equals: Prisma.DbNull } }
      },
      data: { state: 'SCHEDULED', lastError: 'stale_claim_recovered' }
    });
    const staleWithoutDigest = await prisma.notificationDelivery.deleteMany({
      where: { state: 'PENDING', createdAt: { lt: staleCutoff } }
    });
    if (staleWithDigest.count > 0) {
      console.warn(`[notify] ${staleWithDigest.count} 条陈旧 PENDING 占位转为待重发（保留原 digestKey，重发即幂等）`);
    }
    if (staleWithoutDigest.count > 0) {
      console.warn(`[notify] 清理了 ${staleWithoutDigest.count} 条无 digestKey 的陈旧占位，这些候选将重新入选`);
    }
  }

  // 先把上一轮暂时失败、留成 SCHEDULED 的批次原样重发，再去扫新候选。
  // 顺序不能反：这些行仍在库里，collectCandidates 会把它们排除在新批次之外，
  // 于是「原批次重发」与「新告警组新批」互不干扰。
  // 注意本轮的健康检查在**收集候选之后**才做（没东西可发时不打扰机器人），
  // 所以 resumeScheduledBatches 自己会先探一次健康，避免机器人离线时空耗重试次数。
  // 偏好必须在**重发之前**加载：重发路径同样要尊重「用户已关掉这个类型」
  // 以及定时/限额设置。首次投递失败后用户去关掉了某类通知，
  // 重试时还照发出去，等于设置根本没生效。
  const prefsByUser = await loadNotifyPrefs(prisma, userIds);

  const replayResult = await resumeScheduledBatches(
    prisma, targetByUserId, summary, Boolean(options.dryRun), options.shouldStop, revalidateTarget, prefsByUser,
    new Set([...prefsByUser].filter(([, p]) => p.mode === 'DAILY_DIGEST').map(([uid]) => uid))
  );
  const replayedCount = replayResult.replayed;
  const replaySkipped = replayResult.skipped;

  // 定时用户可能需要比标准回看窗口更早的内容（见 lastDigestSentAt 的说明）。
  // 存在定时用户时把查询窗口放宽到两倍，再按每个用户各自的下限过滤 ——
  // 放宽是有界的（最坏 23 小时时点位移 + 24 小时窗口 < 48 小时），
  // 不会退化成全表扫描。
  const hasDigestUser = [...prefsByUser.values()].some((p) => p.mode === 'DAILY_DIGEST');
  // 放宽窗口**绝不能越过冷启动闸门**。
  //
  // startAt 是「这个系统从哪一刻起才允许推送」的硬边界 —— 上线时库里有约
  // 1.5 万条历史告警，闸门就是唯一挡住它们的东西。
  // 直接 Math.min(floor, now-48h) 会把起点推到闸门之前，
  // 定时用户于是可能收到上线前的积压，甚至把全局熔断顶跳闸。
  // 放宽只在「闸门之后」的范围内进行。
  const widened = Date.now() - 2 * LOOKBACK_HOURS * 3600 * 1000;
  const collectFloor = hasDigestUser
    ? new Date(Math.max(startAt.getTime(), Math.min(floor.getTime(), widened)))
    : floor;
  const collected = await collectCandidates(prisma, userIds, collectFloor);

  // 每个用户的真实下限：实时用户用标准窗口；定时用户用「上次汇总之后」，
  // 这样改时点造成的超长间隔也能被完整覆盖。
  const userFloor = new Map<number, Date>();
  for (const uid of userIds) {
    const prefs = prefsByUser.get(uid);
    if (prefs?.mode !== 'DAILY_DIGEST') { userFloor.set(uid, floor); continue; }
    const last = prefs.lastDigestCutoffAt;
    if (!last) {
      // 从未发过汇总：没有「需要补回的历史周期」，就该用标准回看窗口。
      // 用放宽后的 48 小时会让一个绑定已久的用户在**第一封**汇总里
      // 收到 24–48 小时前的旧未读，而配置写的是 24 小时。
      userFloor.set(uid, floor > startAt ? floor : startAt);
      continue;
    }
    // 起点往回留一段**安全重叠**。
    //
    // 截止线是墙上时钟，不是「已提交水位线」：一条 detectedAt 早于截止线的告警，
    // 完全可能在 collectCandidates 取快照之后才提交 —— 本轮看不见它，
    // 而截止线一旦被持久化，下一轮又因为「早于起点」被永久排除。
    // 重扫是安全的：dedupeKey 会挡住已经推过的，重叠只是多查一点。
    const OVERLAP_MS = 15 * 60 * 1000;
    const anchored = last ? new Date(last.getTime() - OVERLAP_MS) : null;
    const candidateFloor = anchored && anchored > collectFloor ? anchored : collectFloor;
    userFloor.set(uid, candidateFloor > startAt ? candidateFloor : startAt);
  }

  // 每个收件人还有自己的起点：绑定生效时刻。
  //
  // 全局闸门与回看窗口只管「系统整体从哪天开始推」，管不了「这个人从哪一刻起同意接收」。
  // 不加这层过滤的话，用户绑完 QQ 的第一轮就会收到绑定**之前**最多 24 小时的积压 ——
  // 他授权的是今后的动态，不是过去一天的，观感上像是刚绑就被刷屏。
  // 这里只过滤不记账：这些候选会随回看窗口自然滑出，不必为它们写一堆抑制记录。
  const candidates: Candidate[] = [];
  let preBindingSkipped = 0;
  const optedOut: Candidate[] = [];
  for (const c of collected) {
    const boundAt = targetByUserId.get(c.userId)?.verifiedAt ?? null;
    if (boundAt && c.detectedAt <= boundAt) { preBindingSkipped += 1; continue; }
    // 每人各自的下限（实时=标准窗口；定时=上次汇总之后）
    const myFloor = userFloor.get(c.userId);
    if (myFloor && c.detectedAt < myFloor) continue;
    // 该用户把这个类型的 QQ 推送关掉了。
    // 注意这**不影响站内** —— 两个渠道各自独立，站内照常展示。
    // 缺省 true：没设置过的用户默认全收，绑定后立刻可用。
    if (prefsByUser.get(c.userId)?.qqEnabled.get(c.notifyType) === false) { optedOut.push(c); continue; }
    candidates.push(c);
  }
  // 关闭期间的候选必须**落账为 SUPPRESSED**，不能只是丢掉。
  // 只丢掉的话它们每轮都会被重新扫到，用户一旦在回看窗口内重新打开该类型，
  // 关闭期间攒下的全部告警会一次性倒灌过去 —— 而他期望的是「从现在起开始收」。
  if (optedOut.length > 0) {
    const byUser = new Map<number, Candidate[]>();
    for (const c of optedOut) {
      const l = byUser.get(c.userId) ?? []; l.push(c); byUser.set(c.userId, l);
    }
    for (const [uid, items] of byUser) {
      await recordAll(prisma, items, uid, 'SUPPRESSED', 'type_disabled', options.dryRun);
    }
    summary.suppressed += optedOut.length;
    console.log(`[notify] 按用户偏好抑制 ${optedOut.length} 条（对应类型的 QQ 推送已关闭）`);
  }
  if (preBindingSkipped > 0) {
    console.log(`[notify] 跳过 ${preBindingSkipped} 条产生于绑定生效之前的告警`);
  }

  // ── 定时用户的资格判定必须在**熔断计数之前** ──────────────────
  //
  // 定时用户的候选会在一天里不断堆积，但其中只有「到点的那些人」本轮真会发出去。
  // 若把全部堆积量计入熔断，几个不同时点的定时用户攒够量就能把全局熔断顶跳闸，
  // 连带把实时用户也一起卡死 —— 而实际要发的量根本没超标。
  // 所以先剔除本轮无资格的，再计数。
  const digestDeferred: Candidate[] = [];
  const eligible: Candidate[] = [];
  const digestEligibility = new Map<number, boolean>();
  const digestCutoffByUser = new Map<number, Date>();
  /**
   * 周期内**存在但本轮没能发出**的内容。
   *
   * 「本轮没发出去」有三种，必须分开：
   *   1. 周期内确实没内容           → 周期算过完，水位线该推进
   *   2. 有内容但被优雅停机跳过      → 没过完，推进就等于丢弃
   *   3. 有内容但被「每天一封」挡住   → 同上（多个逾期周期时会遇到）
   * 只有第 1 种能预先标记为已处理。
   */
  const hasUnsentInPeriod = new Set<number>();
  /** 本轮处理完的用户 —— 只有他们的周期水位线可以推进 */
  const processedUserIds = new Set<number>();
  for (const c of candidates) {
    const prefs = prefsByUser.get(c.userId);
    if (prefs?.mode !== 'DAILY_DIGEST') { eligible.push(c); continue; }
    let ok = digestEligibility.get(c.userId);
    let cutoff = digestCutoffByUser.get(c.userId);
    if (ok === undefined) {
      // 到期时刻由「上次截止线」推算，而不是比较「今天几点」。
      // 逾期未发的汇总（比如跨午夜宕机漏掉的那封）在恢复后第一轮就补上，
      // 且它的截止线仍是原定那个时刻，两次汇总的覆盖区间照样接得上。
      cutoff = nextDigestDueAt(prefs.lastDigestCutoffAt, prefs.digestHour);
      // 「一个周期一封」是对用户的承诺，必须显式守住。
      // 只判「到期了没」是不够的：这个周期已收过、随后把时点改晚，
      // 那个更晚的边界会再次到期，于是同周期发第二封。
      // 日限额（默认 20）拦不住这个。
      // 这里只**读**；真正的占位在发送前那一步原子完成（见 claimDigestSlot）。
      // 在资格判定里就占的话，最终没内容可发的用户会白占掉当天名额。
      const slot = await readDigestSlot(prisma, c.userId, cutoff);
      ok = Date.now() >= cutoff.getTime() && slot === null;
      digestEligibility.set(c.userId, ok);
      digestCutoffByUser.set(c.userId, cutoff);
    }
    // 属于本周期（早于截止线）却没资格发出去 —— 记下来，
    // 这个用户的周期还没过完，水位线不能推进
    if (!ok && cutoff && c.detectedAt < cutoff) hasUnsentInPeriod.add(c.userId);
    // 只收**截止线之前**产生的内容。补发补的是「到点时本该发却没发出去的那批」，
    // 不是「到点之后又新来的」—— 否则设定 21 点的用户会在半夜收到消息。
    if (ok && cutoff && c.detectedAt < cutoff) eligible.push(c);
    else digestDeferred.push(c);
  }
  if (digestDeferred.length > 0) {
    console.log(`[notify] ${digestDeferred.length} 条属于定时用户且本轮未到点，留待其设定时段`);
  }
  candidates.length = 0;
  candidates.push(...eligible);

  // 到期却没有任何可发内容的定时用户（空周期、内容全被站内读掉或被偏好抑制），
  // 根本不会进入下面的收件人循环 —— 但他们的周期确实**已经过完了**。
  // 不把他们算作已处理的话，水位线停在那个空周期上，
  // 之后每一条新告警都晚于它而被无限推迟，这个用户从此收不到汇总。
  const nowMs = Date.now();
  const usersWithEligible = new Set(candidates.map((c) => c.userId));
  for (const [userId, prefs] of prefsByUser) {
    if (prefs.mode !== 'DAILY_DIGEST') continue;
    const due = nextDigestDueAt(prefs.lastDigestCutoffAt, prefs.digestHour);
    if (nowMs < due.getTime()) continue;
    // 有待发内容的：等他在下面的循环里真正处理完再标记 ——
    // 优雅停机可能让他根本轮不到，那时推进水位线会把内容永久丢掉。
    if (usersWithEligible.has(userId)) continue;
    // 周期内有内容但被挡住（每天一封 / 多个逾期周期）：周期没过完，不能推进。
    if (hasUnsentInPeriod.has(userId)) continue;
    // 到这里才是真正的空周期
    processedUserIds.add(userId);
  }

  summary.candidates = candidates.length;
  if (candidates.length === 0) {
    // 空批次也要先推进水位线再返回 —— 否则「今天没内容」会把水位线永久冻住
    await advanceDigestWatermarks(prisma, prefsByUser, Boolean(options.dryRun), processedUserIds);
    // 重发因机器人不可用而被跳过时，这一轮**不算成功**。
    // 照旧推进 lastSuccessAt 的话，notify-inspect 在整个宕机期间都显示
    // 「刚刚成功过」，而队列里的投递一条都发不出去 —— 正好瞒住了要排查的问题。
    if (!options.dryRun && !replaySkipped) {
      await prisma.notificationDispatchState.update({
        where: { id: 1 }, data: { lastSuccessAt: new Date() }
      });
    }
    if (replaySkipped) summary.skippedReason = 'bot_unavailable';
    return summary;
  }

  // 单轮上限是**整轮**的，重发已经用掉的额度要一并计入 ——
  // 否则故障恢复时可以先发满一份重发、再发满一份新投递，实际是宣称上限的两倍。
  if (candidates.length + replayedCount > CIRCUIT_GLOBAL_MAX) {
    const reason = replayedCount > 0
      ? `单轮候选 ${candidates.length} 条 + 已重发 ${replayedCount} 条超过全局上限 ${CIRCUIT_GLOBAL_MAX}`
      : `单轮候选 ${candidates.length} 条超过全局上限 ${CIRCUIT_GLOBAL_MAX}`;
    if (options.resetCircuit) {
      // --reset-circuit 时必须**消化掉**触发跳闸的那批积压，否则复位后立刻重新扫到
      // 同一批候选、再次跳闸 —— 熔断从此永远恢复不了，除非等它们过了回看窗口
      // 或运维手动改上限。这里把它们标成 SUPPRESSED（不是失败，是主动放弃），
      // 并把闸门推进到最新一条之后，让下一轮从干净状态开始。
      const newest = candidates.reduce((a, c) => (c.detectedAt > a ? c.detectedAt : a), candidates[0].detectedAt);

      // dry-run 必须在这里彻底止步。原先这段无条件写库：
      //   * recordAll 硬编码 dryRun=false → 把整批积压永久标成 SUPPRESSED
      //   * 紧接着推进 cutoffAt
      // 于是一条自称「只打印不改动」的演练命令，会把积压**真的丢掉**且不可补发。
      // 演练要能安全地回答「复位会发生什么」，就绝不能顺手把它做掉。
      if (options.dryRun) {
        console.warn(
          `[notify][dry-run] 若执行 --reset-circuit：会把 ${candidates.length} 条积压标记为 SUPPRESSED`
          + `（不发送、不补发），并把闸门推进到 ${newest.toISOString()}。本次未写入任何数据。`
        );
        summary.circuitTripped = true;
        return summary;
      }

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
    // 同理：演练不该把真实的投递器打停。持久化 circuitTrippedAt 之后，
    // 生产的 scpper-notify 会一直停在熔断态直到人工复位 —— 一次 dry-run 造成
    // 真实停摆，是最不该有的副作用。
    if (!options.dryRun) {
      await prisma.notificationDispatchState.update({
        where: { id: 1 },
        data: { circuitTrippedAt: new Date(), circuitReason: reason }
      });
    } else {
      console.warn('[notify][dry-run] 未持久化熔断状态（真实运行时会写入并停止投递直到复位）');
    }
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
    // 在**收件人之间**检查停止信号：这里是两次原子投递的边界，
    // 停在这儿不会留下任何中间态。
    if (options.shouldStop?.()) {
      console.log('[notify] 收到停止信号，本轮剩余收件人留待下次');
      break;
    }
    const items = group;
    const target = targetByUserId.get(userId);
    if (!target) continue;

    items.sort((a, b) => a.detectedAt.getTime() - b.detectedAt.getTime());

    // 日限额按**私信条数**计，不是按告警条数。
    //
    // 原先数的是 state='SENT' 的 NotificationDelivery 行数，但一轮只会给一个用户
    // 发**一条**摘要，那一条摘要里的每个告警都各占一行。于是一条含 20 个告警的摘要
    // 直接吃掉 40 的一半，默认配额下每天只能发两条消息，之后当天所有告警被永久
    // SUPPRESSED（不重试、不补发）——活跃作者会被静默掐掉。
    //
    // 现在给同一次摘要里的所有行写同一个 digestKey，按 distinct digestKey 计数，
    // 「40 条/天」才真的是「每天最多 40 条私信」。
    const prefs = prefsByUser.get(userId) ?? { qqEnabled: new Map(), ...DEFAULT_PREFS };
    const dayAgo = new Date(Date.now() - 24 * 3600 * 1000);
    const sentToday = await countDigestsSentSince(prisma, userId, dayAgo);

    // 定时模式：只在用户指定的整点发，且当天只发一次。
    // 不到点就**留着**（不落库、不消耗任何配额），等到点那一轮再一起发 ——
    // 这正是「每日汇总」的意义：把一天的动静攒成一条。
    // 定时资格已在熔断计数之前统一判定过（含「过点补发」与自然日去重），
    // 这里不再重复判断 —— 判两次容易两处口径不一致。

    // 日限额：定时模式用**自然日**计数，与上面的资格判定同口径。
    // 否则 qqDailyLimit=1 的定时用户会被昨天那条汇总卡住 ——
    // 滚动 24 小时窗口里还能看到它，于是今天整批被记为 SUPPRESSED，永久丢失。
    const limitBaseline = prefs.mode === 'DAILY_DIGEST'
      ? await countDigestsSentSince(prisma, userId, startOfUtc8Day())
      : sentToday;
    if (limitBaseline >= prefs.dailyLimit) {
      await recordAll(prisma, items, userId, 'SUPPRESSED', 'daily_limit', options.dryRun);
      summary.suppressed += items.length;
      console.warn(`[notify] 用户 ${target.wikidotId} 已发 ${limitBaseline} 条，达其上限 ${prefs.dailyLimit}，本批抑制`);
      continue;
    }

    // 超出 CIRCUIT_USER_MAX 的部分不丢弃，由摘要末尾的「另有 N 条」覆盖 ——
    // 它们同属这一条私信，因此照常记为 SENT。
    const shown = items.slice(0, CIRCUIT_USER_MAX);
    const overflow = items.length - shown.length;
    let message = renderDigest(shown, overflow);
    // 一次摘要一个 key：既是 qqbot 侧的去重键，也是上面日限额的计数单位。
    const digestKey = `digest:${userId}:${shown[shown.length - 1].dedupeKey}`;

    if (options.dryRun) {
      console.log(`[notify][dry-run] → ${target.wikidotId}（${items.length} 条，本条为今日第 ${sentToday + 1} 条）\n${message}\n`);
      summary.sent += items.length;
      continue;
    }

    // 长轮次里这份目标快照可能已经过期，发送前复验一次
    const liveTarget = await revalidateTarget(target);
    if (!liveTarget) continue;

    // 发送**之前**先把这批 dedupeKey 以 PENDING 占住。
    // 原先是先发后记账：若机器人已经收下但响应丢失、或进程在 recordAll 前退出，
    // 这批候选下轮仍会被扫到，等机器人那 15 分钟去重窗口一过就会重复推送给用户。
    const keys = items.map((c) => c.dedupeKey);
    // createMany 的 skipDuplicates 会静默跳过别人已抢到的 key，但**不会**告诉我们跳了哪些。
    // 手动 PM2 轮次与 --once 手工轮次重叠时，两边都可能扫到同一批候选，
    // 输的那一方仍会把完整摘要发出去 → 用户收到两条一样的消息。
    // 这里比对「插入前后本轮 key 的归属」，只在确实是自己抢到时才发送。
    // digestKey 在占位时就写进 payload：SENT 那步用的是 updateMany，
    // 没法顺手往 JSON 里合并字段，而日限额的计数正依赖它。
    // 定时模式把本次的截止线一并存下 —— 它是下一次收集的起点（见 lastDigestCutoff）
    const digestCutoff = prefs.mode === 'DAILY_DIGEST' ? digestCutoffByUser.get(userId) : undefined;
    // 定时模式：先原子占住「这一天的汇总名额」，再去占各条 dedupeKey。
    // 顺序不能反 —— 两轮的 key 集合可能不同，各自都能占到自己那批。
    if (digestCutoff && !(await claimDigestSlot(prisma, userId, digestCutoff, digestKey))) {
      console.warn(`[notify] 用户 ${target.wikidotId} 当天的汇总名额已被占用，本轮退让`);
      continue;
    }
    const claimed = await recordAll(
      prisma, items, userId, 'PENDING', null, false, digestKey, target.bindingId, digestCutoff
    );
    if (claimed < items.length) {
      // 部分抢占：另一轮已经占住其中一些 key。此时若照发整批摘要，
      // 被对方占住的那几条就会被发两次。撤掉自己这部分占位、整批退让，
      // 下一轮由唯一的胜出者完整处理。
      await prisma.notificationDelivery.deleteMany({
        where: { dedupeKey: { in: keys }, state: 'PENDING', payload: { path: ['runId'], equals: RUN_ID } }
      });
      // 整批退让就要把名额还回去，否则这个用户当天再也发不出汇总
      if (digestCutoff) await releaseDigestSlot(prisma, userId, digestCutoff, digestKey);
      console.warn(
        `[notify] 用户 ${target.wikidotId} 的候选被另一轮部分抢占`
        + `（${claimed}/${items.length}），本轮整批退让`
      );
      continue;
    }

    // 发送前**再查一次已读**。
    //
    // collectCandidates 到这里之间隔着占位写入与（可能的）健康检查，
    // 用户完全可能在这个窗口里于网页上把这些提醒读掉 ——
    // 读完了还收到 QQ 推送是很突兀的体验。
    // 重发路径早就做了这个检查，常规路径一直没有：同一件事只做了一半。
    const ackedNow = await findAcknowledgedDedupeKeys(prisma, keys);
    if (ackedNow.size > 0) {
      const remaining = items.filter((c) => !ackedNow.has(c.dedupeKey));
      await prisma.notificationDelivery.updateMany({
        where: {
          dedupeKey: { in: [...ackedNow] },
          state: 'PENDING',
          payload: { path: ['runId'], equals: RUN_ID }
        },
        data: { state: 'CANCELLED', lastError: 'acknowledged_on_site' }
      });
      summary.suppressed += ackedNow.size;
      console.log(`[notify] 用户 ${target.wikidotId} 有 ${ackedNow.size} 条在发送前已被站内读掉，取消推送`);
      if (remaining.length === 0) continue;
      // 整批只剩一部分：重新渲染消息，digestKey 保持不变（机器人侧去重语义不变）
      const reshown = remaining.slice(0, CIRCUIT_USER_MAX);
      message = renderDigest(reshown, remaining.length - reshown.length);
      keys.length = 0;
      keys.push(...remaining.map((c) => c.dedupeKey));
    }

    processedUserIds.add(userId);

    // 统计口径必须是「本次真正参与投递的条数」。
    // 发送前的已读回查可能已经取消掉一部分（那部分已计入 suppressed），
    // 若这里仍按原始 items.length 计，同一条会被同时算进 suppressed 与 sent/failed，
    // 摘要里的数字自相矛盾，排查时反而误导人。
    const dispatchedCount = keys.length;

    const result = await pushQqMessage({ qq: liveTarget.address, message, dedupeKey: digestKey });

    if (result.ok) {
      await prisma.notificationDelivery.updateMany({
        where: { dedupeKey: { in: keys }, state: 'PENDING', payload: { path: ['runId'], equals: RUN_ID } },
        data: { state: 'SENT', sentAt: new Date(), lastError: null }
      });
      summary.sent += dispatchedCount;
      // 汇总周期状态必须在**发送成功后**推进，且记的是截止线而非发送时刻。
      // 记发送时刻的话，补发场景下 21:00–23:00 之间的内容会两头不沾。
      if (digestCutoff) {
        await prisma.userNotificationChannelSetting.updateMany({
          where: { userId },
          data: { lastDigestCutoffAt: digestCutoff }
        });
      }
      // 成功要清零 failureCount，否则一次永久失败之后，日后**不连续**的偶发失败
      // 会累加到阈值，把一个正常渠道误暂停。
      await reportChannelOutcome(liveTarget.accountId, liveTarget.bindingId, 'sent', null);
    } else if (isPermanentFailure(result.error)) {
      await prisma.notificationDelivery.updateMany({
        where: { dedupeKey: { in: keys }, state: 'PENDING', payload: { path: ['runId'], equals: RUN_ID } },
        data: { state: 'FAILED', lastError: result.error ?? 'unknown' }
      });
      summary.failed += dispatchedCount;
      console.warn(`[notify] 用户 ${target.wikidotId} 永久失败：${result.error}（不再重试）`);
      // 把永久失败回报给绑定方。不报的话：绑定一直是 ACTIVE、界面显示健康，
      // 而每条新告警都有新的 dedupeKey，于是对着一个已经删了机器人的用户永远重试下去。
      await reportChannelOutcome(liveTarget.accountId, liveTarget.bindingId, 'failed', result.error ?? 'unknown');
    } else {
      // 可重试：**保留这一批**，转 SCHEDULED 等下轮原样重发。
      //
      // 原先是直接删掉占位、让候选下轮重新入选。问题出在「机器人已经收下、
      // 但响应超时」这种情况：下一轮会重新组批，若期间来了新告警，
      // 摘要就多一行，digestKey 随之改变，qqbot 的 15 分钟去重表认不出来，
      // 用户于是又收到一遍之前那些行。
      // 保留原批次意味着重发时 digestKey 完全一致：机器人若真收下过就会去重，
      // 若确实没发成（它在发送失败时会撤掉去重记录）则正常送达。
      // 新来的告警自己组成新的一批，互不干扰。
      await prisma.notificationDelivery.updateMany({
        where: { dedupeKey: { in: keys }, state: 'PENDING', payload: { path: ['runId'], equals: RUN_ID } },
        // scheduledAt = 下次可重试的时刻，重发侧只捞到期的
        data: { state: 'SCHEDULED', lastError: result.error ?? 'unknown', scheduledAt: nextRetryAt(1) }
      });
      summary.failed += dispatchedCount;
      console.warn(`[notify] 用户 ${target.wikidotId} 暂时失败：${result.error}（保留原批次，下轮以同一 digestKey 重发）`);
    }
  }

  // 本轮到期的定时周期一律推进水位线 —— 包括「没东西可发」的空周期。
  // 只在发送成功时推进的话，一个空周期就能把水位线永久冻住。
  await advanceDigestWatermarks(prisma, prefsByUser, Boolean(options.dryRun), processedUserIds);

  if (!options.dryRun) {
    await prisma.notificationDispatchState.update({
      where: { id: 1 }, data: { lastSuccessAt: new Date() }
    });
  }
  return summary;
}

/**
 * 向 user-backend 回报渠道投递失败，由它累计 failureCount 并在阈值处暂停渠道。
 * 失败只记日志不抛 —— 回报不上不该影响本轮其余用户的投递。
 */
let warnedMissingNotifyKey = false;

async function reportChannelOutcome(
  accountId: string,
  bindingId: string,
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
        body: JSON.stringify({ accountId, bindingId, channel: 'QQ', outcome, ...(code ? { code } : {}) })
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
  dryRun?: boolean,
  /** 同一条摘要里的所有行共享它；日限额按 distinct digestKey 计数 */
  digestKey?: string,
  /** 投递目标的绑定身份。重发时用它确认「这批还是发给当初那个绑定」 */
  bindingId?: string,
  /** 定时模式下本次汇总的截止线，作为下次收集的起点 */
  digestCutoff?: Date
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
      payload: {
        source: c.source,
        line: c.line,
        // 合并字段一并存下：重发时只有 payload，没有原始候选，
        // 不存的话同一批重发出来的格式会和首次不一致
        groupKey: c.groupKey,
        // 重发时要据此判断「用户是否已关掉这个类型」，不存就无从判断
        notifyType: c.notifyType,
        ...(c.mergeHead ? { mergeHead: c.mergeHead } : {}),
        ...(c.mergePart ? { mergePart: c.mergePart } : {}),
        ...(c.mergeTail ? { mergeTail: c.mergeTail } : {}),
        detectedAt: c.detectedAt.toISOString(),
        runId: RUN_ID,
        ...(digestKey ? { digestKey } : {}),
        ...(bindingId ? { bindingId } : {}),
        ...(digestCutoff ? { digestCutoff: digestCutoff.toISOString() } : {})
      }
    })),
    skipDuplicates: true
  });
  return created.count;
}

/**
 * 用户的通知偏好（QQ 侧）。
 *
 * 一次查两张表：类型矩阵 + 渠道级设置。都在主库，与告警同库同键（User.id），
 * 不必跨库。没有记录的用户走默认值 —— 默认全开、实时、20 条/天，
 * 这样新用户绑定后立刻能收到，不用先去设置页点一遍。
 */
interface UserNotifyPrefs {
  /** 该类型是否推 QQ；缺省 true */
  qqEnabled: Map<NotifyType, boolean>;
  dailyLimit: number;
  mode: 'REALTIME' | 'DAILY_DIGEST';
  digestHour: number;
  /** 上一次汇总的截止线；null = 从未发过 */
  lastDigestCutoffAt: Date | null;
}

const DEFAULT_PREFS: Omit<UserNotifyPrefs, 'qqEnabled'> = {
  dailyLimit: 20,
  mode: 'REALTIME',
  digestHour: 21,
  lastDigestCutoffAt: null
};

export async function loadNotifyPrefs(prisma: PrismaClient, userIds: number[]): Promise<Map<number, UserNotifyPrefs>> {
  const out = new Map<number, UserNotifyPrefs>();
  if (userIds.length === 0) return out;

  const [rows, settings] = await Promise.all([
    prisma.userNotificationPreference.findMany({
      where: { userId: { in: userIds } },
      select: { userId: true, type: true, qqEnabled: true }
    }),
    prisma.userNotificationChannelSetting.findMany({
      where: { userId: { in: userIds } },
      select: { userId: true, qqDailyLimit: true, qqMode: true, qqDigestHour: true, lastDigestCutoffAt: true }
    })
  ]);

  // 默认值同样要钳制：运维把 NOTIFY_DAILY_LIMIT 调到 20 以下时，
  // 没有设置行的用户若保留默认 20，就绕过了运维上限。
  const defaults = { ...DEFAULT_PREFS, dailyLimit: Math.max(1, Math.min(DEFAULT_PREFS.dailyLimit, DAILY_LIMIT)) };
  for (const uid of userIds) out.set(uid, { qqEnabled: new Map(), ...defaults });
  for (const r of rows) out.get(r.userId)?.qqEnabled.set(r.type as NotifyType, r.qqEnabled);
  for (const c of settings) {
    const p = out.get(c.userId);
    if (!p) continue;
    // 用户值不得突破运维设定的全局上限 —— 取两者更小
    p.dailyLimit = Math.max(1, Math.min(c.qqDailyLimit, DAILY_LIMIT));
    p.mode = c.qqMode as 'REALTIME' | 'DAILY_DIGEST';
    p.digestHour = c.qqDigestHour;
    p.lastDigestCutoffAt = c.lastDigestCutoffAt ?? null;
  }
  return out;
}

/** UTC+8 的当前小时。定时推送按用户所在时区（站点统一 UTC+8）解释。 */
/** UTC+8 当天 0 点对应的 UTC 时刻。用于「今天发过没」这类自然日判断。 */
export function startOfUtc8Day(): Date {
  const shifted = new Date(Date.now() + 8 * 3600 * 1000);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - 8 * 3600 * 1000);
}

/**
 * 下一次汇总的到期时刻 = 上次截止线之后的第一个 digestHour 边界。
 *
 * 【为什么不是「今天的 digestHour」】
 * 宕机跨过午夜时（比如周二 21:00 到周三 01:00），只比较「今天几点」的做法
 * 会把周二那封未发的汇总推到周三 21:00 —— 而两次截止线相隔约 48 小时，
 * 早期内容已经被收集窗口丢掉了。
 * 以「上次截止线」为基准推算，逾期的汇总在恢复后的第一轮就会补上，
 * 且它的截止线仍然是周二 21:00，覆盖区间照样接得上。
 *
 * 从未发过时（lastCutoff 为 null）退回今天的 digestHour。
 */
export function nextDigestDueAt(lastCutoff: Date | null, digestHour: number): Date {
  const todayBoundary = utc8HourToday(digestHour);
  if (!lastCutoff) return todayBoundary;
  const DAY = 24 * 3600 * 1000;
  let due = todayBoundary;
  // 往前退到「刚好晚于上次截止线」的那个边界
  while (due.getTime() - DAY > lastCutoff.getTime()) due = new Date(due.getTime() - DAY);
  // 若今天的边界还不晚于上次截止线，则顺延到下一天
  while (due.getTime() <= lastCutoff.getTime()) due = new Date(due.getTime() + DAY);
  return due;
}

/** UTC+8 今天 hour:00 对应的 UTC 时刻。用于「本次汇总收哪些内容」的截止线。 */
export function utc8HourToday(hour: number): Date {
  const shifted = new Date(Date.now() + 8 * 3600 * 1000);
  shifted.setUTCHours(hour, 0, 0, 0);
  return new Date(shifted.getTime() - 8 * 3600 * 1000);
}

export function currentHourUtc8(): number {
  return new Date(Date.now() + 8 * 3600 * 1000).getUTCHours();
}


/**
 * 推进定时用户的周期水位线。
 *
 * 【为什么不能只在「发送成功」时推进】
 * 一个到期的周期完全可能没有任何内容（用户那天没动静），或者内容全被
 * 站内读掉/被偏好抑制。这些情况下没有任何一次发送发生，水位线就停在原地 ——
 * nextDigestDueAt 之后永远返回那个空周期的边界，而**每一条新告警都晚于它**，
 * 于是被无限推迟，这个用户从此再也收不到汇总。
 *
 * 正确的语义是：**周期到期并被处理过**就推进，与是否真的发出消息无关。
 * 内容若因暂时失败进了重发队列，那批自己带着 digestCutoff，不会丢。
 */
async function advanceDigestWatermarks(
  prisma: PrismaClient,
  prefsByUser: Map<number, UserNotifyPrefs>,
  dryRun: boolean,
  /**
   * 本轮**真正处理完**的用户。优雅停机时循环会提前 break，
   * 剩下的用户被明确留给下一轮 —— 给他们推进水位线等于宣称
   * 「这个周期处理过了」，而下一轮的起点（水位线 - 15 分钟重叠）
   * 会把他们那个周期的绝大部分内容直接丢掉。
   */
  processedUserIds: Set<number>
): Promise<void> {
  if (dryRun) return;
  const now = Date.now();
  for (const [userId, prefs] of prefsByUser) {
    if (prefs.mode !== 'DAILY_DIGEST') continue;
    if (!processedUserIds.has(userId)) continue;
    const due = nextDigestDueAt(prefs.lastDigestCutoffAt, prefs.digestHour);
    if (now < due.getTime()) continue;          // 还没到期
    if (prefs.lastDigestCutoffAt && due <= prefs.lastDigestCutoffAt) continue;
    await prisma.userNotificationChannelSetting.updateMany({
      where: { userId },
      data: { lastDigestCutoffAt: due }
    });
  }
}


/**
 * 周期边界所属的 UTC+8 自然日（YYYY-MM-DD）—— 汇总名额的单位。
 *
 * 是**边界归属的那一天**，不是消息发出去的那一天。两个方向都踩过坑：
 *  · 按「发出去那天」算：跨午夜的补发会吃掉新一天的额度 → 当天设定时点被挡 →
 *    次日又逾期又在午夜后补发，用户被**永久相位锁死在午夜**。
 *  · 按「单个边界」算：同一天里把时点从 10:00 改到 21:00，会产生两个不同的
 *    边界，于是当天发两封 —— 而设置页承诺的是每天一封。
 * 取「边界所属的自然日」两者都对。
 */
export function utc8DayOf(cutoff: Date): string {
  return new Date(cutoff.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * 读取该用户这一天的汇总名额占用情况。
 *
 * 名额记在专门的 DigestSlotClaim 上，而不是从投递表的 payload 形状反推 ——
 * 后者试过，站不住：历史的实时投递行带着 digestKey 却没有 digestCutoff，
 * 任何「视 null 为匹配所有周期」的写法都会把发过实时消息的用户永久挡死；
 * 而反过来忽略它们又会漏掉模式切换前的残留。名额是独立的状态，就该独立存。
 */
async function readDigestSlot(
  prisma: PrismaClient, userId: number, cutoff: Date
): Promise<{ digestKey: string | null } | null> {
  const rows = await prisma.$queryRaw<Array<{ digestKey: string | null }>>`
    SELECT "digestKey" FROM "DigestSlotClaim"
    WHERE "userId" = ${userId} AND "cutoffDay" = ${utc8DayOf(cutoff)}::date
    LIMIT 1`;
  return rows[0] ?? null;
}

/**
 * 原子占住该用户这一天的汇总名额；已被占则返回 false。
 *
 * 「先查再占」两步之间存在窗口：两轮投递重叠时（PM2 常驻轮次 + 手工 --once），
 * 双方都可能查到空槽。已有的 per-key 占位挡不住这个 —— 两轮的 dedupeKey 集合
 * 可以不同（PageMetricAlert 是就地合并的，内容签名会变），于是各自抢到各自那批，
 * 两封摘要都发出去。主键冲突把这两步压成一步。
 */
async function claimDigestSlot(
  prisma: PrismaClient, userId: number, cutoff: Date, digestKey: string
): Promise<boolean> {
  const n = await prisma.$executeRaw`
    INSERT INTO "DigestSlotClaim" ("userId","cutoffDay","cutoffAt","digestKey")
    VALUES (${userId}, ${utc8DayOf(cutoff)}::date, ${cutoff}, ${digestKey})
    ON CONFLICT ("userId","cutoffDay") DO NOTHING`;
  return n > 0;
}

/** 占了名额但这批最终没发出去时归还，否则用户白丢一天的汇总。
 *  带 digestKey 条件，保证只归还自己那一份。 */
async function releaseDigestSlot(
  prisma: PrismaClient, userId: number, cutoff: Date, digestKey: string
): Promise<void> {
  await prisma.$executeRaw`
    DELETE FROM "DigestSlotClaim"
    WHERE "userId" = ${userId} AND "cutoffDay" = ${utc8DayOf(cutoff)}::date
      AND "digestKey" = ${digestKey}`;
}

/** SCHEDULED 批次最多重发几轮，超过就判失败不再占位 */
const MAX_RESUME_ATTEMPTS = Math.max(1, Number(process.env.NOTIFY_MAX_RESUME_ATTEMPTS ?? '5') || 5);
/** 目标已消失的 SCHEDULED 批次保留多久后判失败（默认 24 小时） */
const ORPHAN_SCHEDULED_MAX_AGE_MS = 24 * 3600 * 1000;
/**
 * 重试退避基数（秒）。第 N 轮重发等 BASE * 2^(N-1)，上限 30 分钟。
 *
 * 不退避的话，暂时失败的批次每 60 秒就重试一次，默认 5 次上限五分钟就耗尽 ——
 * 而 rate_limited 这类失败恰恰需要「等一会儿再说」，密集重试只会一直撞在同一堵墙上，
 * 然后把一条本可以送达的通知判成永久失败。
 */
const RETRY_BACKOFF_BASE_SEC = Math.max(30, Number(process.env.NOTIFY_RETRY_BACKOFF_BASE_SEC ?? '120') || 120);
const RETRY_BACKOFF_MAX_MS = 30 * 60 * 1000;

function nextRetryAt(resumeRound: number): Date {
  const ms = Math.min(RETRY_BACKOFF_BASE_SEC * 1000 * Math.pow(2, Math.max(0, resumeRound - 1)), RETRY_BACKOFF_MAX_MS);
  return new Date(Date.now() + ms);
}

/**
 * 把超出回看窗口的 SCHEDULED 批次判失效。
 *
 * 整个投递器的承诺是「超过 NOTIFY_LOOKBACK_HOURS 的告警不再补发」——
 * 正常扫描严格按这个窗口取候选，重发路径却只按投递状态取行、不看年龄。
 * 于是机器人若离线超过窗口时长，恢复那一刻会把几天前的动态推给用户，
 * 与承诺相悖，观感上也像「系统积压了一堆旧消息一起吐出来」。
 *
 * 必须在健康检查与重发**之前**跑：过期的本来就不该发，
 * 不该因为机器人恰好不可用就一直留着。
 */
async function expireStaleScheduledBatches(
  prisma: PrismaClient,
  dryRun: boolean,
  /** 当前处于定时模式的用户。判定必须看**现在的模式**，不能看 payload 里的痕迹 —— 
   *  用户可能是在批次转 SCHEDULED 之后才切换过来的。 */
  digestUserIds?: Set<number>
): Promise<number> {
  const cutoff = new Date(Date.now() - LOOKBACK_HOURS * 3600 * 1000);
  // 定时汇总的批次用**放宽一倍**的时限。
  //
  // 按来源事件时间判过期本身是对的（见下），但定时汇总攒的就是一整天的内容 ——
  // 它最老的那几条在发出时本来就接近回看窗口上限。一旦这批暂时失败转为
  // SCHEDULED，下一轮的过期清理会立刻把它们判死，于是**定时用户的批次
  // 只要失败一次就再也重试不了**，补发场景下更是整批必死。
  const digestCutoff = new Date(Date.now() - 2 * LOOKBACK_HOURS * 3600 * 1000);

  // 按**来源事件时间**判过期，不是按占位时间。
  // createdAt 记的是投递器什么时候认领了它，一条在窗口边缘才被认领的告警，
  // 按 createdAt 还能再苟一整个窗口期，实际送达时已经接近两倍于配置的时限。
  // payload.detectedAt 是告警本身发生的时刻，才是「多旧」的正确度量。
  // COALESCE 兜底：没有 detectedAt 的历史行退回 createdAt。
  const whereExpired = {
    state: 'SCHEDULED' as const,
    AND: [
      {
        OR: [
          { payload: { path: ['detectedAt'], lt: cutoff.toISOString() } },
          { AND: [{ payload: { path: ['detectedAt'], equals: Prisma.DbNull } }, { createdAt: { lt: cutoff } }] }
        ]
      },
      {
        // 定时用户的批次只有超过放宽时限才判死。
        // 按 userId 而非 payload 判断：用户可能在批次转 SCHEDULED 之后
        // 才切成定时模式，那时 payload 里根本没有 digestCutoff。
        OR: [
          ...(digestUserIds && digestUserIds.size > 0
            ? [{ userId: { notIn: [...digestUserIds] } }]
            : []),
          { payload: { path: ['detectedAt'], lt: digestCutoff.toISOString() } },
          ...(digestUserIds && digestUserIds.size > 0 ? [] : [{ userId: { gt: -1 } }])
        ]
      }
    ]
  };
  if (dryRun) {
    const n = await prisma.notificationDelivery.count({ where: whereExpired });
    if (n > 0) console.warn(`[notify][dry-run] 有 ${n} 条 SCHEDULED 已超出回看窗口，真实运行会判失效`);
    return n;
  }
  const res = await prisma.notificationDelivery.updateMany({
    where: whereExpired,
    data: { state: 'FAILED', lastError: 'expired_beyond_lookback' }
  });
  if (res.count > 0) {
    console.warn(`[notify] ${res.count} 条待重发记录已超出回看窗口（${LOOKBACK_HOURS} 小时），判失效不再补发`);
  }
  return res.count;
}

/**
 * 重发上一轮暂时失败、被留成 SCHEDULED 的批次。
 *
 * 【为什么要单独一步而不是让它们重新入选】
 * 重新入选就会重新组批：期间来了新告警，摘要内容变、digestKey 变，
 * qqbot 的去重表认不出来，「已收下但响应超时」的那条就会被重复推送。
 * 这里按 digestKey 原样取回、原样重发，机器人那侧要么去重（说明上次真收下了）、
 * 要么正常送达（它在发送失败时会撤掉去重记录），两种情况都正确。
 *
 * 必须在扫描新候选**之前**跑：collectCandidates 会排除已有投递记录的候选，
 * 所以这些行不会被重复计入新批次。
 */
async function resumeScheduledBatches(
  prisma: PrismaClient,
  targetByUserId: Map<number, QqTarget>,
  summary: DispatchSummary,
  dryRun: boolean,
  shouldStop?: () => boolean,
  /** 发送前复验绑定（与常规投递共用同一份实现与缓存） */
  revalidateTarget?: (t: QqTarget) => Promise<QqTarget | null>,
  /** 与常规投递共用同一份偏好，保证两条路径行为一致 */
  prefsByUser?: Map<number, UserNotifyPrefs>,
  /** 当前处于定时模式的用户，用于过期判定 */
  digestUserIds?: Set<number>
): Promise<{ replayed: number; skipped: boolean }> {
  // 先把超窗的判失效，再取待重发的 —— 顺序不能反：
  // 过期与否和机器人健不健康无关，不该被下面的健康检查挡住。
  await expireStaleScheduledBatches(prisma, dryRun, digestUserIds);

  const now = new Date();
  const rows = await prisma.notificationDelivery.findMany({
    // 只捞已到重试时刻的（scheduledAt 为空的是旧数据，视为立即可重试）
    where: {
      state: 'SCHEDULED',
      channel: 'QQ',
      OR: [{ scheduledAt: null }, { scheduledAt: { lte: now } }]
    },
    orderBy: { createdAt: 'asc' }
  });
  if (rows.length === 0) return { replayed: 0, skipped: false };

  // 机器人离线时不要重发：每次失败都会 +1 attemptCount，
  // 一次几分钟的宕机就能把批次推到 MAX_RESUME_ATTEMPTS 而被误判为永久失败。
  // 「发不出去」和「不该发」是两回事，前者应该原地等待。
  if (!dryRun) {
    const health = await checkHealth();
    if (!health.ok) {
      console.warn(`[notify] qqbot 不可用，${rows.length} 条待重发的记录留到下轮（不计入重试次数）`);
      return { replayed: 0, skipped: true };
    }
  }

  // 按 digestKey 分组还原原批次
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    const key = typeof payload.digestKey === 'string' ? payload.digestKey : null;
    if (!key) continue; // 没有 digestKey 的重建不出原消息，交给陈旧清理兜底
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }

  // 用户可能在这期间**在站内读掉了**这些告警。正常扫描会把已读的排除在外，
  // 重发路径却只按投递状态取行、不回看来源 —— 于是「网页上早看过了，
  // 过一会儿 QQ 又推一遍」。CANCELLED 这个状态本来就是为这种情况留的。
  const acknowledged = await findAcknowledgedDedupeKeys(prisma, rows.map((r) => r.dedupeKey));

  // 本轮最多重发多少条记录。重发同样受全局上限约束：
  // 机器人健康但发送持续暂时失败时，队列会越积越多，
  // 不设上限就会在恢复的那一刻一次性灌出去。
  // 本轮已经用掉的额度。重发和随后的新投递**共用**这一个单轮上限 ——
  // 各算各的话，一次故障恢复可以先发满 CIRCUIT_GLOBAL_MAX 条重发、
  // 紧接着新候选再发满一份，实际吐出去两倍于宣称的上限。
  let replayed = 0;
  let replayBudget = CIRCUIT_GLOBAL_MAX;
  // 每个用户当天已发的私信条数，边发边累加，避免重发绕过日限额
  const sentTodayByUser = new Map<number, number>();
  const dayAgo = new Date(Date.now() - 24 * 3600 * 1000);

  for (const [digestKey, batch] of groups) {
    if (shouldStop?.()) {
      console.log('[notify] 收到停止信号，剩余待重发批次留待下次');
      break;
    }
    const first = batch[0];
    if (!first) continue;
    const keys = batch.map((r) => r.dedupeKey);
    const target = targetByUserId.get(first.userId);

    if (!target) {
      // 用户已解绑/停用/被移出灰度名单。这批永远发不出去了，
      // 但陈旧清理只扫 PENDING，放着不管就是一批永久占着 dedupeKey 的僵尸行 ——
      // 既不会重发，也会一直把对应告警挡在新批次之外。超过保留期就判失败。
      const age = Date.now() - first.createdAt.getTime();
      if (age > ORPHAN_SCHEDULED_MAX_AGE_MS && !dryRun) {
        await prisma.notificationDelivery.updateMany({
          where: { dedupeKey: { in: keys }, state: 'SCHEDULED' },
          data: { state: 'FAILED', lastError: 'target_gone' }
        });
        console.warn(`[notify] 批次 ${digestKey} 的投递目标已不存在且超过保留期，判定失败`);
      }
      continue;
    }

    // attemptCount 在首次投递（recordAll）时就被写成 1，所以「已重发过的轮数」
    // 是 max(attemptCount) - 1，本次将是第 resumeRound 轮重发。
    // 原先直接拿 max+1 去比 MAX_RESUME_ATTEMPTS，默认 5 实际只重发 4 次，
    // 配成 1 时一次都不会重发 —— 与这个常量的字面含义不符。
    // 这批当初是发给**哪个绑定**的？必须和现在的绑定身份一致才继续。
    //
    // 用户可能在这批还挂着 SCHEDULED 时解绑并绑了另一个 QQ。
    // 只按 userId 找 target 的话，这批陈年通知就会被投递到**新号**上 ——
    // 新绑定授权的是「今后的动态」，收到的却是他授权之前、发给旧号的内容。
    // 双保险：绑定身份变了直接作废；身份没变但事件早于新的 verifiedAt 也作废。
    const batchBindingId = ((batch[0].payload ?? {}) as Record<string, unknown>).bindingId;
    const bindingChanged = typeof batchBindingId === 'string' && batchBindingId !== target.bindingId;
    const predatesAuthorization = target.verifiedAt != null && batch.every((r) => {
      const detected = ((r.payload ?? {}) as Record<string, unknown>).detectedAt;
      return typeof detected === 'string' && new Date(detected) <= target.verifiedAt!;
    });
    if (bindingChanged || predatesAuthorization) {
      console.warn(
        `[notify] 批次 ${digestKey} ${bindingChanged ? '所属绑定已变更' : '早于当前绑定的授权时刻'}，作废不再投递`
      );
      if (!dryRun) {
        await prisma.notificationDelivery.updateMany({
          where: { dedupeKey: { in: keys }, state: 'SCHEDULED' },
          data: { state: 'CANCELLED', lastError: bindingChanged ? 'binding_changed' : 'predates_binding' }
        });
      }
      summary.suppressed += batch.length;
      continue;
    }

    const attempt = Math.max(...batch.map((r) => r.attemptCount)) + 1;
    const resumeRound = attempt - 1;

    if (resumeRound > MAX_RESUME_ATTEMPTS) {
      const lastError = batch.find((r) => r.lastError)?.lastError ?? 'max_resume_attempts';
      console.warn(`[notify] 批次 ${digestKey} 已重发 ${MAX_RESUME_ATTEMPTS} 次仍失败（${lastError}），判定失败不再重试`);
      if (!dryRun) {
        await prisma.notificationDelivery.updateMany({
          where: { dedupeKey: { in: keys }, state: 'SCHEDULED' },
          data: { state: 'FAILED', lastError: 'max_resume_attempts' }
        });
        // 重试耗尽必须回报渠道健康度。原先只落了 FAILED 就完事，
        // 绑定仍是 ACTIVE、failureCount 纹丝不动，于是**每一条**新告警都要
        // 完整走一遍「发→失败→重试 5 轮→放弃」，而界面上渠道一直显示健康。
        // 这类持续失败（send_failed 等）正是自动暂停机制该介入的场景。
        await reportChannelOutcome(target.accountId, target.bindingId, 'failed', lastError);
      }
      summary.failed += batch.length;
      continue;
    }

    // 用户在首次投递失败之后关掉了这个类型 → 取消，不再重发。
    // 「我已经关掉了它，为什么还收到」是最直接的设置失效体感。
    const prefs = prefsByUser?.get(first.userId);
    const optedOut = new Set<string>();
    if (prefs) {
      for (const r of batch) {
        const t = ((r.payload ?? {}) as Record<string, unknown>).notifyType;
        if (typeof t === 'string' && prefs.qqEnabled.get(t as NotifyType) === false) {
          optedOut.add(r.dedupeKey);
        }
      }
    }
    if (optedOut.size > 0) {
      if (!dryRun) {
        await prisma.notificationDelivery.updateMany({
          where: { dedupeKey: { in: [...optedOut] }, state: 'SCHEDULED' },
          data: { state: 'CANCELLED', lastError: 'type_disabled' }
        });
      }
      summary.suppressed += optedOut.size;
      console.log(`[notify] 批次 ${digestKey} 有 ${optedOut.size} 条的类型已被用户关闭，取消重发`);
    }

    // 站内已读的那些直接取消，不再推送
    const stillPending = batch.filter((r) => !acknowledged.has(r.dedupeKey) && !optedOut.has(r.dedupeKey));
    const cancelledKeys = batch.filter((r) => acknowledged.has(r.dedupeKey)).map((r) => r.dedupeKey);
    if (cancelledKeys.length > 0) {
      if (!dryRun) {
        await prisma.notificationDelivery.updateMany({
          where: { dedupeKey: { in: cancelledKeys }, state: 'SCHEDULED' },
          data: { state: 'CANCELLED', lastError: 'acknowledged_on_site' }
        });
      }
      // 计入 suppressed，否则运维摘要与账本对不上（取消掉的既不算 sent 也不算 failed）
      summary.suppressed += cancelledKeys.length;
      console.log(`[notify] 批次 ${digestKey} 有 ${cancelledKeys.length} 条已在站内读过，取消推送`);
    }
    if (stillPending.length === 0) {
      // 整批都读过了，不必再发。digestKey 保持不变没有意义了，直接跳过。
      continue;
    }

    // 日限额：重发同样算私信条数，否则「失败-重试」这条路径可以完全绕开限额
    const userId = first.userId;
    let sentToday = sentTodayByUser.get(userId);
    if (sentToday === undefined) {
      sentToday = await countDigestsSentSince(prisma, userId, dayAgo);
      sentTodayByUser.set(userId, sentToday);
    }
    // 限额与定时同样按每人设置，两条投递路径的行为必须一致
    const effLimit = prefs?.dailyLimit ?? DAILY_LIMIT;
    // 这批所属周期的截止线（仅定时模式有意义）；发送成功后据此推进水位线
    let batchCutoff: Date | null = null;
    if (prefs?.mode === 'DAILY_DIGEST') {
      // 与常规路径同口径：过点即可补发，且「今天发过没」按 UTC+8 自然日算。
      // sentToday 是滚动 24 小时的计数，用在这里会让昨天晚些时候发出的汇总
      // 一直挡住今天的重发，直到它滑出窗口 —— 那时批次可能已经过期。
      // 资格看**这批自己的截止线**，不是「今天几点」。
      //
      // 一个待重发的定时批次，其截止线在它进入队列时就已经过去了 ——
      // 它欠的是那个周期的账。若机器人在午夜后、今天设定时点之前恢复，
      // 再按「今天几点」判断会把它压到今晚，期间最老的行可能已经过期。
      // 批次自带 digestCutoff 时直接用它；没有的（实时模式下攒的、
      // 之后才切成定时）退回按本周期的到期时刻判断。
      const storedCutoff = ((batch[0]?.payload ?? {}) as Record<string, unknown>).digestCutoff;
      batchCutoff = typeof storedCutoff === 'string'
        ? new Date(storedCutoff)
        : nextDigestDueAt(prefs.lastDigestCutoffAt, prefs.digestHour);
      if (Date.now() < batchCutoff!.getTime()) continue;   // 本周期还没到期
      // 没有 digestCutoff 的批次（模式切换而来）还要确认内容不晚于截止线
      if (typeof storedCutoff !== 'string') {
        const anyAfterCutoff = batch.some((r) => {
          const d = ((r.payload ?? {}) as Record<string, unknown>).detectedAt;
          return typeof d === 'string' && new Date(d) >= batchCutoff!;
        });
        if (anyAfterCutoff) continue;
      }
    }
    // 定时模式的「一天一封」必须独立判定，不能拿 qqDailyLimit 比 ——
    // 那个上限默认 20，用它判定等于允许一天发二十封「每日汇总」。
    if (prefs?.mode === 'DAILY_DIGEST' && batchCutoff) {
      const slot = await readDigestSlot(prisma, first.userId, batchCutoff);
      if (slot) {
        // 槽位是别人的（当天已有另一封）就跳过；是自己的才继续重发
        if (slot.digestKey !== digestKey) {
          console.warn(`[notify] 用户 ${target.wikidotId} 当天已有另一封汇总，批次 ${digestKey} 跳过`);
          continue;
        }
      } else if (!(await claimDigestSlot(prisma, first.userId, batchCutoff, digestKey))) {
        // 没有槽位（模式切换前攒下的批次）则现占；抢不到说明有别人，退让
        console.warn(`[notify] 用户 ${target.wikidotId} 当天的汇总名额已被占用，批次 ${digestKey} 跳过`);
        continue;
      }
    }
    const limitBaseline = sentToday;
    if (prefs?.mode !== 'DAILY_DIGEST' && limitBaseline >= effLimit) {
      console.warn(`[notify] 用户 ${target.wikidotId} 已达日限额 ${effLimit}，批次 ${digestKey} 留待下轮`);
      continue;
    }
    // 必须在**发送前**确认额度够装下整批：原先只判 >0，
    // 于是剩 1 条额度也会把一整批（可能几十条）发出去，再把额度减成负数 ——
    // 单轮实际可超出 CIRCUIT_GLOBAL_MAX 将近一整批。
    if (replayBudget < stillPending.length) {
      console.warn(
        `[notify] 本轮重发额度剩 ${replayBudget} 条，装不下批次 ${digestKey}（${stillPending.length} 条），`
        + `其余留待下轮（全局上限 ${CIRCUIT_GLOBAL_MAX}）`
      );
      break; // 其余保持 SCHEDULED
    }
    replayBudget -= stillPending.length;
    replayed += stillPending.length;

    const replayKeys = stillPending.map((r) => r.dedupeKey);
    const shown = stillPending.slice(0, CIRCUIT_USER_MAX);
    const overflow = stillPending.length - shown.length;
    // 从 payload 还原**完整的**合并信息，而不是只取 line。
    // 只取 line 的话，首次已经合并成一行的内容在重发时会重新摊回多行 ——
    // 用户会看到「同一批通知第二次来的时候变样了」。
    // 这些字段正是占位时特意存下来的，不用就白存了。
    const asStr = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
    const items: MergeItem[] = shown.map((r) => {
      const payload = (r.payload ?? {}) as Record<string, unknown>;
      return {
        line: asStr(payload.line) ?? '(内容缺失)',
        groupKey: asStr(payload.groupKey),
        mergeHead: asStr(payload.mergeHead),
        mergePart: asStr(payload.mergePart),
        mergeTail: asStr(payload.mergeTail)
      };
    });
    // digestKey 保持不变：即使内容因取消已读而变短，机器人仍按 key 去重，
    // 「上次其实已送达」的情况照样能被挡住。
    const message = renderMerged(items, overflow);

    if (dryRun) {
      console.log(`[notify][dry-run] 重发 → ${target.wikidotId}（${stillPending.length} 条，第 ${resumeRound} 轮重发，今日第 ${sentToday + 1} 条）\n${message}\n`);
      summary.sent += stillPending.length;
      sentTodayByUser.set(userId, sentToday + 1);
      continue;
    }

    // 与常规投递一致：发送前复验绑定。
    // 多个待重发批次到期时这个循环可能跑上几分钟，期间用户解绑/重绑/被暂停的话，
    // 不复验就会把通知发到一个已经撤销授权的号上。
    const liveTarget = revalidateTarget ? await revalidateTarget(target) : target;
    if (!liveTarget) continue;

    const result = await pushQqMessage({ qq: liveTarget.address, message, dedupeKey: digestKey });
    if (result.ok) {
      await prisma.notificationDelivery.updateMany({
        where: { dedupeKey: { in: replayKeys }, state: 'SCHEDULED' },
        data: { state: 'SENT', sentAt: new Date(), lastError: null, attemptCount: attempt }
      });
      summary.sent += stillPending.length;
      // 重发成功同样要推进水位线 —— 否则后续扫描仍盯着旧边界，
      // 而这批行已是 SENT 被排除在外，更新的告警又全部晚于旧边界被推迟，
      // 这个用户从此收不到任何汇总。
      if (prefs?.mode === 'DAILY_DIGEST' && batchCutoff) {
        await prisma.userNotificationChannelSetting.updateMany({
          where: { userId: first.userId },
          data: { lastDigestCutoffAt: batchCutoff }
        });
      }
      // 计入当日私信条数：同一轮里该用户还有别的批次时，限额要立刻生效
      sentTodayByUser.set(userId, sentToday + 1);
      console.log(`[notify] 批次 ${digestKey} 重发成功${result.deduped ? '（机器人判定为重复，说明上次已送达）' : ''}`);
      await reportChannelOutcome(liveTarget.accountId, liveTarget.bindingId, 'sent', null);
    } else if (isPermanentFailure(result.error)) {
      await prisma.notificationDelivery.updateMany({
        where: { dedupeKey: { in: replayKeys }, state: 'SCHEDULED' },
        data: { state: 'FAILED', lastError: result.error ?? 'unknown', attemptCount: attempt }
      });
      summary.failed += stillPending.length;
      await reportChannelOutcome(liveTarget.accountId, liveTarget.bindingId, 'failed', result.error ?? 'unknown');
    } else {
      const retryAt = nextRetryAt(resumeRound + 1);
      await prisma.notificationDelivery.updateMany({
        where: { dedupeKey: { in: replayKeys }, state: 'SCHEDULED' },
        data: { lastError: result.error ?? 'unknown', attemptCount: attempt, scheduledAt: retryAt }
      });
      summary.failed += stillPending.length;
      console.warn(
        `[notify] 批次 ${digestKey} 第 ${resumeRound} 轮重发仍失败：${result.error}，`
        + `下次重试 ${retryAt.toISOString()}`
      );
    }
  }
  return { replayed, skipped: false };
}

/**
 * 找出这些 dedupeKey 里，来源告警**已在站内被读掉**的那些。
 *
 * dedupeKey 的前缀就是来源表、第二段就是主键（见 collectCandidates）：
 *   pma:<PageMetricAlert.id>:...  uaa:<UserActivityAlert.id>:...  fia:<ForumInteractionAlert.id>
 * 正常扫描本来就会把已读的排除在外，重发路径也必须做同样的检查 ——
 * 否则用户在网页上看完，过一会儿 QQ 还会再推一遍。
 */
async function findAcknowledgedDedupeKeys(
  prisma: PrismaClient,
  dedupeKeys: string[]
): Promise<Set<string>> {
  const acked = new Set<string>();
  // 一个来源 id 可能对应**多个** dedupeKey：PageMetricAlert / UserActivityAlert
  // 是就地合并的，同一行的 newValue 变化会生成新的键，而旧版本可能还留在 SCHEDULED。
  // 用 Map<id, string> 只会保住最后一个键，于是把来源标已读时只取消得掉一个版本，
  // 更早的版本照样会被重发出去。
  const byPrefix = {
    pma: new Map<number, string[]>(),
    uaa: new Map<number, string[]>(),
    fia: new Map<number, string[]>()
  };
  const push = (m: Map<number, string[]>, id: number, key: string) => {
    const list = m.get(id);
    if (list) list.push(key); else m.set(id, [key]);
  };

  for (const key of dedupeKeys) {
    const [prefix, rawId] = key.split(':');
    if (!prefix || !rawId) continue;
    const id = Number.parseInt(rawId, 10);
    if (!Number.isFinite(id)) continue;
    if (prefix === 'pma') push(byPrefix.pma, id, key);
    else if (prefix === 'uaa') push(byPrefix.uaa, id, key);
    else if (prefix === 'fia') push(byPrefix.fia, id, key);
  }

  const lookups: Array<Promise<void>> = [];
  if (byPrefix.pma.size > 0) {
    lookups.push((async () => {
      const rows = await prisma.pageMetricAlert.findMany({
        where: { id: { in: [...byPrefix.pma.keys()] }, acknowledgedAt: { not: null } },
        select: { id: true }
      });
      for (const r of rows) for (const k of byPrefix.pma.get(r.id) ?? []) acked.add(k);
    })());
  }
  if (byPrefix.uaa.size > 0) {
    lookups.push((async () => {
      const rows = await prisma.userActivityAlert.findMany({
        where: { id: { in: [...byPrefix.uaa.keys()] }, acknowledgedAt: { not: null } },
        select: { id: true }
      });
      for (const r of rows) for (const k of byPrefix.uaa.get(r.id) ?? []) acked.add(k);
    })());
  }
  if (byPrefix.fia.size > 0) {
    lookups.push((async () => {
      const rows = await prisma.forumInteractionAlert.findMany({
        where: { id: { in: [...byPrefix.fia.keys()] }, acknowledgedAt: { not: null } },
        select: { id: true }
      });
      for (const r of rows) for (const k of byPrefix.fia.get(r.id) ?? []) acked.add(k);
    })());
  }
  await Promise.all(lookups);
  return acked;
}

/**
 * 过去 24 小时真正发给该用户的**私信条数**。
 *
 * 用 distinct digestKey 而不是行数：一条摘要 = 一条私信 = 一个 digestKey，
 * 无论它里面打包了多少条告警。SUPPRESSED / FAILED / PENDING 都不算。
 *
 * 走原生 SQL 是因为 Prisma 不支持对 JSON 路径做 COUNT(DISTINCT)。
 * 没有 digestKey 的行（本改动之前写入的）自然被排除，宁可少算也不多算。
 */
async function countDigestsSentSince(
  prisma: PrismaClient,
  userId: number,
  since: Date
): Promise<number> {
  // 按 sentAt 而不是 createdAt 计窗口：SCHEDULED 批次可能在创建很久之后才发出去，
  // 用 createdAt 的话它一发出就已经落在 24 小时窗口之外、完全不占额度，
  // 于是「故障恢复」这条路径可以让当天实际发出的条数超过 NOTIFY_DAILY_LIMIT。
  // sentAt 为空的历史行退回 createdAt，避免旧数据整批不计。
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(DISTINCT payload->>'digestKey') AS count
    FROM "NotificationDelivery"
    WHERE "userId" = ${userId}
      AND state = 'SENT'
      AND COALESCE("sentAt", "createdAt") > ${since}
      AND payload->>'digestKey' IS NOT NULL
  `;
  return Number(rows[0]?.count ?? 0);
}

function renderDigest(items: Candidate[], overflow: number): string {
  return renderMerged(items, overflow);
}

/**
 * 从纯文本行渲染摘要（兼容旧数据）。
 * 重发路径若碰到没有合并字段的历史行，退回逐行展示。
 */
function renderDigestLines(itemLines: string[], overflow: number): string {
  return renderMerged(itemLines.map((line) => ({ line })), overflow);
}

/**
 * 把候选合并后渲染成一条私信。
 *
 * 合并规则按 groupKey 分组，组内两种情况：
 *  - 可拼接（页面指标）：同一页面的不同指标并成
 *    「你的《X》投票 +12、评论 +3  链接」，而不是三行各说一遍同一个页面
 *  - 不可拼接（关注/论坛）：同组只出一行，末尾标「（N 条）」
 *
 * 保持首次出现的顺序 —— 候选本身按 detectedAt 排序，合并不该打乱时间感。
 */
export function renderMerged(items: MergeItem[], overflow: number): string {
  const groups = new Map<string, MergeItem[]>();
  for (const [i, it] of items.entries()) {
    // 没有 groupKey 的（历史数据）各自成组，行为与合并前一致
    const key = it.groupKey ?? `__solo:${i}`;
    const g = groups.get(key);
    if (g) g.push(it); else groups.set(key, [it]);
  }

  const rendered: string[] = [];
  for (const group of groups.values()) {
    const first = group[0]!;
    const parts = group.map((g) => g.mergePart).filter((x): x is string => Boolean(x));
    if (first.mergeHead && parts.length === group.length) {
      // 同一页面的多个指标：去重后按出现顺序拼接
      const uniq = [...new Set(parts)];
      const tail = first.mergeTail ? `  ${first.mergeTail}` : '';
      rendered.push(`${first.mergeHead}${uniq.join('、')}${tail}`);
    } else if (group.length > 1) {
      rendered.push(`${first.line}（${group.length} 条）`);
    } else {
      rendered.push(first.line);
    }
  }

  const lines = ['【scpper-cn】', ''];
  for (const line of rendered) lines.push(`· ${line}`);
  if (overflow > 0) lines.push(`· …另有 ${overflow} 条`);
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
      notifyType: METRIC_TO_TYPE[metric] ?? 'PAGE_COMMENT',
      // 键里带 detectedAt：PageMetricAlert 是就地更新的，只带 newValue 的话
      // 「20→40→20→40」这种来回变动，最后那次 40 会撞到早先 40 的键而被当成已投递。
      dedupeKey: `pma:${r.id}:${r.newValue ?? 'n'}:${new Date(String(r.detectedAt)).getTime()}`,
      userId: Number(r.userId),
      detectedAt: new Date(String(r.detectedAt)),
      // 同一页面的不同指标要能并成一行，所以按页面分组，指标本身作为可拼接片段
      groupKey: `page:${r.pageWikidotId ?? r.pageUrl ?? r.pageId}`,
      mergeHead: `你的《${pageLabel(r)}》`,
      mergePart: `${label} ${delta}`.trim(),
      mergeTail: pageUrl(r),
      // 单条时的形态；与合并后保持一致的措辞
      line: `你的《${pageLabel(r)}》${`${label} ${delta}`.trim()}  ${pageUrl(r)}`
    });
  }

  // ② 关注作者动态
  const followRows = await prisma.$queryRaw<Row[]>`
    SELECT ua.id, ua.type, ua."detectedAt", ua."followerId", ua."revisionId", ua."pageVersionId",
           p."wikidotId" AS "pageWikidotId", p."currentUrl" AS "pageUrl",
           pv.title AS "pageTitle", pv."alternateTitle" AS "pageAlternateTitle",
           ua."targetUserId" AS "targetUserId",
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
      notifyType: 'FOLLOW_ACTIVITY',
      dedupeKey: `uaa:${r.id}:${r.revisionId ?? r.pageVersionId ?? 'n'}`,
      userId: Number(r.followerId),
      detectedAt: new Date(String(r.detectedAt)),
      // 同一作者对同一页面的多次动作合并成一条，末尾标条数
      // 必须用 targetUserId 而非显示名：两个被关注者若同名（或都没有显示名），
      // 在同一页面上的动态会被误合并成一条，后一个人的动态直接消失。
      groupKey: `follow:${r.targetUserId ?? 'unknown'}:${r.pageWikidotId ?? r.pageId}`,
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
      notifyType: 'FORUM_INTERACTION',
      dedupeKey: `fia:${r.id}`,
      userId: Number(r.recipientUserId),
      detectedAt: new Date(String(r.detectedAt)),
      // 同一话题里的多条互动合并成一条，末尾标条数
      groupKey: `forum:${r.threadId ?? r.postId}`,
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

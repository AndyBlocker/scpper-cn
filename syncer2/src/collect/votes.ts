/**
 * M2 · WhoRatedPageModule 投票采集。
 *
 * 本文件只做三件事：
 *   1. 经既有 HttpClient / amcRequest 抓一页；
 *   2. 把 HTML 解析成带四类身份的观测，且“合法空结果”与“解析失败”是两个类型分支；
 *   3. 经 ensure_user + apply_vote_snapshot 落库，不直接写 ingest/serve 事实表。
 *
 * 最危险的边界不是 HTTP 失败，而是 wikidot 对错误 pageId 返回 status=ok + 合法空 HTML。
 * 因此 entries=0 且 Tier1 claimed_total>0 在这里和数据库函数里各挡一次。
 */

import { createHash } from 'node:crypto';
import { load, type CheerioAPI } from 'cheerio';
import type { Pool, PoolClient } from 'pg';

import { amcRequest } from '../http/amc.js';
import type { HttpClient } from '../http/client.js';
import { query, toPgTimestamptz, withTransaction } from '../store/db.js';
import { recordPageScan } from '../store/meta.js';
import { toPgJson } from '../store/pgText.js';
import { mapWithConcurrency } from '../util/concurrency.js';
import { throwIfRuntimeBudgetExceeded } from '../util/runtimeBudget.js';
import {
  buildTargetedListPagesRequest,
  isStructurallyEmptyTargetedListPages as isStructurallyEmptyListPages,
  parseTargetedListPage,
} from './listpages.js';

export type VoteDirection = -1 | 1;
export type VoteScanStatus = 'ok' | 'partial' | 'failed';

export interface WikidotVoteIdentity {
  kind: 'wikidot';
  wikidotId: number | null;
  name: string;
  unixName: string | null;
}

export interface DeletedVoteIdentity {
  kind: 'deleted';
  /** `span.printuser.deleted[data-id]` 有时仍带真实 wikidot 用户 id。 */
  wikidotId: number | null;
  name: string;
}

export interface GuestVoteIdentity {
  kind: 'guest';
  name: string;
  avatarUrl: string | null;
}

export interface AnonymousVoteIdentity {
  kind: 'anonymous';
  /** 这是响应里原样出现的 IP，不由名字派生。空 IP 不允许铸身份。 */
  ip: string | null;
  name: string;
}

export type VoteIdentity =
  | WikidotVoteIdentity
  | DeletedVoteIdentity
  | GuestVoteIdentity
  | AnonymousVoteIdentity;

export interface ParsedVoteEntry {
  identity: VoteIdentity;
  direction: VoteDirection;
  /**
   * 解析层去重键。类型是键的一部分，绝不使用 AbstractUser.id：
   * anonymous / guest / 无 id deleted 的库对象 id 都是 0，按 id 去重会整类塌缩。
   */
  identityKey: string;
  ordinal: number;
}

export interface ParsedVoteSnapshot {
  entries: ParsedVoteEntry[];
  rawEntries: number;
  checksum: number;
  duplicateEntries: number;
  identityKinds: Record<VoteIdentity['kind'], number>;
  /** true 才可把 p_is_complete 传给 apply_vote_snapshot。 */
  isComplete: boolean;
}

export type VoteParseOutcome =
  | { status: 'ok' | 'partial'; data: ParsedVoteSnapshot }
  | { status: 'failed'; error: string };

export interface VoteTarget {
  /** ingest.page.id。 */
  pageId: number;
  /** wikidot pageId，必须随请求回显给 apply_* 做身份校验。 */
  wikidotId: number;
  /** 同一 Tier1 ListPages 证据里的 %%rating_votes%%。 */
  claimedTotal: number | null;
  /** 同一 Tier1 ListPages 证据里的 %%rating%%。 */
  claimedRating: number | null;
}

export interface VoteSnapshotData extends ParsedVoteSnapshot {
  target: VoteTarget;
}

export interface TargetedVoteClaim {
  claimedTotal: number;
  claimedRating: number;
  /** 同一次定向 ListPages 的零基 %%revisions%%，供三角时窗复核。 */
  revisions: number;
}

export type TargetedVoteClaimOutcome =
  | { status: 'ok'; data: TargetedVoteClaim }
  | { status: 'unavailable'; reason: 'listpages_unenumerable'; error: string }
  | { status: 'failed'; error: string };

/**
 * 全站 L1 的 category='*' 不返回 `_template` / `_404` 等少量 live 页面。盲扫不能因此
 * 永久排除它们；缺 claim 时先按 fullname 做一次目标 ListPages 交叉观测，再抓 WhoRated。
 * 这仍保持“两套独立模块互证”，绝不拿本地 page_current 聚合值冒充远端声明。
 */
export function buildTargetedVoteClaimRequest(
  slug: string,
): { moduleName: string; params: Record<string, string | number> } {
  return buildTargetedListPagesRequest(slug);
}

export function parseTargetedVoteClaim(
  body: string,
  slug: string,
): TargetedVoteClaimOutcome {
  const parsed = parseTargetedListPage(body, slug);
  if (parsed.status !== 'ok') return parsed;
  const row = parsed.data;
  return {
    status: 'ok',
    data: {
      claimedTotal: row.ratingVotes,
      claimedRating: row.rating,
      revisions: row.revisions,
    },
  };
}

export function isStructurallyEmptyTargetedListPages(body: string): boolean {
  return isStructurallyEmptyListPages(body);
}

export async function collectTargetedVoteClaim(
  http: HttpClient,
  baseUrl: string,
  slug: string,
): Promise<TargetedVoteClaimOutcome> {
  try {
    const response = await amcRequest(http, baseUrl, {
      ...buildTargetedVoteClaimRequest(slug),
      mode: 'votes:targeted-claim',
      timeoutMs: 20_000,
      maxAttempts: 3,
    });
    if (response.status !== 'ok' || response.body === null) {
      return {
        status: 'failed',
        error:
          `目标 ListPages claim AMC status=${response.status}, ` +
          `body=${response.body === null ? 'null' : 'present'}`,
      };
    }
    return parseTargetedVoteClaim(response.body, slug);
  } catch (err) {
    throwIfRuntimeBudgetExceeded(err);
    return { status: 'failed', error: `目标 ListPages claim 请求失败：${String(err)}` };
  }
}

export type VoteScanOutcome =
  | { status: 'ok' | 'partial'; data: VoteSnapshotData }
  | {
      status: 'failed';
      error: string;
      data?: VoteSnapshotData;
    };

export interface AheadVoteSnapshotReconciliation {
  outcome: VoteScanOutcome;
  /** true 表示后读 ListPages 已证明两次读取之间目标计数或评分发生了变化。 */
  targetChanged: boolean;
}

const SELECTOR_RESIDUE_RE = /%%[^%\r\n]+%%/;
const USER_SELECTOR = 'span.printuser';

/**
 * 解析 WhoRatedPageModule body。
 *
 * 合法空结果必须同时有真实响应的结构锚点（h2 + column-count 容器）；空字符串、
 * WAF HTML、用户/方向数量错位、未知方向、selector 残留全部是 failed，绝不返回 []。
 */
export function parseWhoRatedPage(body: string): VoteParseOutcome {
  if (body.trim() === '') {
    return { status: 'failed', error: 'WhoRated body 为空；这不是合法的 0 票响应' };
  }
  if (SELECTOR_RESIDUE_RE.test(body)) {
    return { status: 'failed', error: 'WhoRated body 含未替换的 %%selector%% 字面量' };
  }

  let $: CheerioAPI;
  try {
    $ = load(body, null, false);
  } catch (err) {
    return { status: 'failed', error: `WhoRated HTML 无法解析：${String(err)}` };
  }

  const heading = $('h2').first().text().trim();
  const columns = $('div[style]').filter((_i, el) =>
    (($(el).attr('style') ?? '').toLowerCase().includes('column-count')),
  );
  if (heading === '' || columns.length === 0) {
    return {
      status: 'failed',
      error: 'WhoRated 缺少 h2/column-count 结构锚点；疑似 WAF、错误页或站点模板变更',
    };
  }

  const users = $(USER_SELECTOR).toArray();
  const values = $('span[style]')
    .filter((_i, el) => /^\s*color\s*:/i.test($(el).attr('style') ?? ''))
    .toArray();
  if (users.length !== values.length) {
    return {
      status: 'failed',
      error: `WhoRated 用户/方向数量错位：users=${users.length}, directions=${values.length}`,
    };
  }

  const entries: ParsedVoteEntry[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  const identityKinds: Record<VoteIdentity['kind'], number> = {
    wikidot: 0,
    deleted: 0,
    guest: 0,
    anonymous: 0,
  };

  for (let i = 0; i < users.length; i++) {
    const $user = $(users[i]!);
    const directionText = $(values[i]!).text().trim();
    const direction: VoteDirection | null =
      directionText === '+' ? 1 : directionText === '-' ? -1 : null;
    if (direction === null) {
      return {
        status: 'failed',
        error: `WhoRated 第 ${i + 1} 行方向不是 +/−：${JSON.stringify(directionText)}`,
      };
    }

    const identity = parseVoteIdentity($, $user, i);
    const identityKey = voteIdentityKey(identity, i);
    entries.push({ identity, direction, identityKey, ordinal: i });
    identityKinds[identity.kind]++;
    if (seen.has(identityKey)) duplicates++;
    else seen.add(identityKey);
  }

  return {
    status: 'ok',
    data: {
      entries,
      rawEntries: users.length,
      checksum: entries.reduce((sum, entry) => sum + entry.direction, 0),
      duplicateEntries: duplicates,
      identityKinds,
      // 同一自然账号的同向或反向多行都是数据源快照的合法多重性。
      isComplete: true,
    },
  };
}

function parseVoteIdentity(
  $: CheerioAPI,
  $user: ReturnType<CheerioAPI>,
  _ordinal: number,
): VoteIdentity {
  const classes = new Set(($user.attr('class') ?? '').split(/\s+/).filter(Boolean));
  const text = $user.text().replace(/\s+/g, ' ').trim();

  if (classes.has('deleted') || text === '(user deleted)') {
    return {
      kind: 'deleted',
      wikidotId: positiveInt($user.attr('data-id')),
      name: text || '(user deleted)',
    };
  }

  if (classes.has('anonymous')) {
    const rawIp = $user.find('span.ip').first().text().replace(/[()]/g, '').trim();
    return {
      kind: 'anonymous',
      ip: rawIp === '' ? null : rawIp,
      name: text || 'Anonymous',
    };
  }

  const gravatar = $user
    .find('img')
    .toArray()
    .map((el) => $(el).attr('src') ?? '')
    .find((src) => /gravatar\.com/i.test(src));
  if (classes.has('guest') || gravatar !== undefined) {
    const linkedName = $user.find('a').last().text().trim();
    return {
      kind: 'guest',
      name: linkedName || text || 'Guest',
      avatarUrl: gravatar ?? null,
    };
  }

  if (text === 'Wikidot') {
    return { kind: 'wikidot', wikidotId: null, name: 'Wikidot', unixName: 'wikidot' };
  }

  const links = $user.find('a');
  if (links.length === 0) {
    // 与 @ukwhatn/wikidot 的实测解析语义一致：无链接的 printuser 是已删用户。
    return { kind: 'deleted', wikidotId: positiveInt($user.attr('data-id')), name: text };
  }

  const $link = links.last();
  const onclick = $link.attr('onclick') ?? '';
  const idMatch = /userInfo\((\d+)\)/.exec(onclick) ?? /userInfo\((\d+)\)/.exec($user.html() ?? '');
  const href = $link.attr('href') ?? '';
  const unixNameMatch = /\/user:info\/([^/?#]+)\/?(?:[?#].*)?$/i.exec(href);
  return {
    kind: 'wikidot',
    wikidotId: positiveInt(idMatch?.[1] ?? $user.attr('data-id')),
    name: $link.text().trim() || text,
    unixName: unixNameMatch?.[1] ? decodeURIComponentSafe(unixNameMatch[1]) : null,
  };
}

/** 类型参与去重；无稳定原始键时用 ordinal 保留每一行，随后进入 quarantine。 */
export function voteIdentityKey(identity: VoteIdentity, ordinal: number): string {
  switch (identity.kind) {
    case 'wikidot':
      return identity.wikidotId === null
        ? `wikidot:unresolved:${ordinal}`
        : `wikidot:${identity.wikidotId}`;
    case 'deleted':
      return identity.wikidotId === null
        ? `deleted:unresolved:${ordinal}`
        : `deleted:${identity.wikidotId}`;
    case 'guest':
      return `guest:${identity.name}`;
    case 'anonymous':
      return identity.ip === null
        ? `anonymous:unresolved:${ordinal}`
        : `anonymous:${identity.ip}`;
  }
}

/**
 * 把结构解析结果与 Tier1 两个 claimed 值交叉分类。
 * 注意：partial 仍携带 data，后续 apply_* 只做单调 upsert；failed 的尾部空列表也携带
 * data，让数据库函数再执行一次 gate⑤并留下 page_scan 证据。
 */
export function gateParsedVotes(
  target: VoteTarget,
  parsed: VoteParseOutcome,
): VoteScanOutcome {
  if (parsed.status === 'failed') return parsed;
  const data: VoteSnapshotData = { ...parsed.data, target };

  // 错 pageId 的真实响应与合法 0 票页字节级同形，只能靠 Tier1 独立计数拆穿。
  if (
    data.entries.length === 0 &&
    (target.claimedTotal === null || target.claimedTotal > 0)
  ) {
    return {
      status: 'failed',
      data,
      error:
        `WhoRated status=ok 且 entries=0，但 claimed_total=${String(target.claimedTotal)}；` +
        '按 §4.4 强制 failed，禁止进入 absence diff',
    };
  }

  const reasons: string[] = [];
  if (target.claimedTotal === null) reasons.push('缺 Tier1 claimed_total');
  else if (data.rawEntries !== target.claimedTotal) {
    reasons.push(`raw_entries=${data.rawEntries} ≠ claimed_total=${target.claimedTotal}`);
  }
  if (target.claimedRating === null) reasons.push('缺 Tier1 claimed_rating');
  else if (data.checksum !== target.claimedRating) {
    reasons.push(`Σsign=${data.checksum} ≠ claimed_rating=${target.claimedRating}`);
  }

  return reasons.length === 0 ? { status: 'ok', data } : { status: 'partial', data };
}

/**
 * 只给 `WhoRated 行数 > 较早 claim` 的单向竞态补一次后读确认。
 * `fetched < claimed` 可能是漏抓，绝不能走同一条放行路径。
 */
export function needsPostWhoRatedClaim(outcome: VoteScanOutcome): boolean {
  return outcome.status === 'partial' &&
    outcome.data !== undefined &&
    outcome.data.target.claimedTotal !== null &&
    outcome.data.rawEntries > outcome.data.target.claimedTotal;
}

/**
 * 用 WhoRated 之后读取的独立 ListPages 计数重新执行原有四门校验。
 * 只有 fresh claim 同时精确匹配 raw row count 与 Σsign 才会变成 ok；这里没有容差，
 * 也不会跨轮拼接明细。目标在后读前继续变化时仍保持 partial。
 */
export function reconcileAheadVoteSnapshot(
  outcome: VoteScanOutcome,
  freshClaim: TargetedVoteClaim,
): AheadVoteSnapshotReconciliation {
  if (!needsPostWhoRatedClaim(outcome) || outcome.data === undefined) {
    return { outcome, targetChanged: false };
  }
  const oldTarget = outcome.data.target;
  const target: VoteTarget = {
    ...oldTarget,
    claimedTotal: freshClaim.claimedTotal,
    claimedRating: freshClaim.claimedRating,
  };
  const regated = gateParsedVotes(target, { status: 'ok', data: outcome.data });
  return {
    outcome: regated,
    targetChanged:
      freshClaim.claimedTotal !== oldTarget.claimedTotal ||
      freshClaim.claimedRating !== oldTarget.claimedRating,
  };
}

/** 5,575 票实测页独占队列；其余按票数分档给超时，避免小页都背 60 秒尾延迟。 */
export function timeoutForVoteCount(claimedTotal: number | null): number {
  if (claimedTotal === null || claimedTotal <= 500) return 20_000;
  if (claimedTotal <= 2_000) return 30_000;
  if (claimedTotal <= 4_000) return 45_000;
  return 60_000;
}

export function isOversizedVotePage(claimedTotal: number | null): boolean {
  return claimedTotal !== null && claimedTotal > 4_000;
}

/**
 * 批量抓取，返回 Map 且每个 target 必有一项。失败不省略、不返回半截数组。
 * >4,000 票的页面串行放在普通批之后，避免 3.6 MB 响应与其它页争 dispatcher。
 */
export async function collectVoteSnapshots(
  http: HttpClient,
  baseUrl: string,
  targets: readonly VoteTarget[],
  concurrency = 4,
): Promise<Map<number, VoteScanOutcome>> {
  const result = new Map<number, VoteScanOutcome>();
  const regular = targets.filter((target) => !isOversizedVotePage(target.claimedTotal));
  const oversized = targets.filter((target) => isOversizedVotePage(target.claimedTotal));

  await mapWithConcurrency(regular, concurrency, async (target) => {
    result.set(target.pageId, await collectOneVoteSnapshot(http, baseUrl, target));
  });
  for (const target of oversized) {
    result.set(target.pageId, await collectOneVoteSnapshot(http, baseUrl, target));
  }

  // 防未来重构中某个分支忘记 set：失败必须显式留在 Map 里。
  for (const target of targets) {
    if (!result.has(target.pageId)) {
      result.set(target.pageId, {
        status: 'failed',
        error: '内部错误：采集结果缺项（已补成 failed，禁止把缺项解释为空票）',
      });
    }
  }
  return result;
}

async function collectOneVoteSnapshot(
  http: HttpClient,
  baseUrl: string,
  target: VoteTarget,
): Promise<VoteScanOutcome> {
  try {
    const response = await amcRequest(http, baseUrl, {
      moduleName: 'pagerate/WhoRatedPageModule',
      params: { pageId: target.wikidotId },
      mode: isOversizedVotePage(target.claimedTotal) ? 'votes:oversized' : 'votes:full',
      timeoutMs: timeoutForVoteCount(target.claimedTotal),
      maxAttempts: 3,
    });
    if (response.status !== 'ok') {
      return {
        status: 'failed',
        error: `WhoRated AMC status=${response.status}, message=${response.message ?? '-'}`,
      };
    }
    if (response.body === null) {
      return { status: 'failed', error: 'WhoRated status=ok 但 body=null' };
    }
    return gateParsedVotes(target, parseWhoRatedPage(response.body));
  } catch (err) {
    throwIfRuntimeBudgetExceeded(err);
    return { status: 'failed', error: String(err) };
  }
}

export interface PreparedVoteSnapshot {
  entries: Array<{
    voter_id: number;
    direction: VoteDirection;
    source_ordinal: number;
    identity_key: string;
  }>;
  quarantined: number;
  identityCollisions: number;
  resultHash: Buffer;
  /** unresolved/quarantine/collision 出现时为 false，绝不授权 absence。 */
  isComplete: boolean;
}

export interface AppliedVoteSnapshot {
  scanStatus: VoteScanStatus;
  resultHash: Buffer;
  quarantined: number;
  identityCollisions: number;
  applyResult: Record<string, unknown>;
}

/**
 * 解析身份 → ensure_user → apply_vote_snapshot，同一事务完成。
 * `deleted` 是本模块新增保留的身份 kind；迁移 0013 放宽 user.kind，并让账号恢复/注销时
 * kind 可在 wikidot↔deleted 间更新。这样 visible_kinds=['wikidot'] 才真的排除已删账号。
 */
export async function applyCollectedVoteSnapshot(
  pool: Pool,
  outcome: VoteScanOutcome,
  runId: number | null,
  observedAt: string,
): Promise<AppliedVoteSnapshot> {
  if (outcome.data === undefined) {
    throw new Error('applyCollectedVoteSnapshot 需要带 data 的解析结果；纯请求失败应只记 page_scan');
  }
  const data = outcome.data;
  return withTransaction(pool, `votes:apply:${data.target.pageId}`, async (client) => {
    const prepared = await prepareVoteSnapshot(client, data.target.pageId, data.entries, observedAt);
    const isComplete = data.isComplete && prepared.isComplete;
    const res = await query<{ applied: Record<string, unknown> }>(
      client,
      'ingest.apply_vote_snapshot',
      `SELECT ingest.apply_vote_snapshot(
                p_page              => $1,
                p_entries           => $2::jsonb,
                p_is_complete       => $3,
                p_claimed_total     => $4,
                p_claimed_rating    => $5,
                p_visible_kinds     => ARRAY['wikidot']::text[],
                p_observed          => $6::timestamptz,
                p_source            => 'wikidot',
                p_run               => $7,
                p_wikidot_id        => $8,
                p_absence_policy    => 'candidate',
                p_max_absence       => 500,
                p_max_absence_ratio => 0.20::real
              ) AS applied`,
      [
        data.target.pageId,
        toPgJson(prepared.entries, `votes.entries:${data.target.pageId}`),
        isComplete,
        data.target.claimedTotal,
        data.target.claimedRating,
        toPgTimestamptz(observedAt),
        runId,
        data.target.wikidotId,
      ],
    );
    const applyResult = res.rows[0]?.applied ?? {};
    const scanStatus = normalizeScanStatus(applyResult['scan_status']);
    const resultHash =
      scanStatus === 'ok'
        ? prepared.resultHash
        : voteSnapshotContradictionHash(data, prepared, scanStatus);
    return {
      scanStatus,
      resultHash,
      quarantined: prepared.quarantined,
      identityCollisions: prepared.identityCollisions,
      applyResult,
    };
  });
}

export async function prepareVoteSnapshot(
  client: PoolClient,
  pageId: number,
  entries: readonly ParsedVoteEntry[],
  observedAt: string,
): Promise<PreparedVoteSnapshot> {
  const resolvable: Array<{
    ordinal: number;
    kind: 'wikidot' | 'deleted' | 'guest' | 'anon';
    wikidot_id: number | null;
    anon_key: string | null;
    display_name: string | null;
    username: string | null;
    unix_name: string | null;
    direction: VoteDirection;
  }> = [];
  const quarantined: Array<{ entry: ParsedVoteEntry; reason: string }> = [];

  for (const entry of entries) {
    const identity = entry.identity;
    if (identity.kind === 'wikidot') {
      if (identity.wikidotId === null) {
        quarantined.push({ entry, reason: 'unresolvable_voter' });
      } else {
        resolvable.push({
          ordinal: entry.ordinal,
          kind: 'wikidot',
          wikidot_id: identity.wikidotId,
          anon_key: null,
          display_name: identity.name || null,
          username: null,
          unix_name: identity.unixName,
          direction: entry.direction,
        });
      }
    } else if (identity.kind === 'deleted') {
      if (identity.wikidotId === null) {
        quarantined.push({ entry, reason: 'unresolvable_voter' });
      } else {
        resolvable.push({
          ordinal: entry.ordinal,
          kind: 'deleted',
          wikidot_id: identity.wikidotId,
          anon_key: null,
          display_name: identity.name || '(user deleted)',
          username: null,
          unix_name: null,
          direction: entry.direction,
        });
      }
    } else if (identity.kind === 'guest') {
      resolvable.push({
        ordinal: entry.ordinal,
        kind: 'guest',
        wikidot_id: null,
        anon_key: null,
        display_name: identity.name,
        username: null,
        unix_name: null,
        direction: entry.direction,
      });
    } else if (identity.ip === null) {
      // 绝不从 "Anonymous" 之类显示名派生 anon_key。
      quarantined.push({ entry, reason: 'anon_without_key' });
    } else {
      resolvable.push({
        ordinal: entry.ordinal,
        kind: 'anon',
        wikidot_id: null,
        // IP 是 WhoRated 响应给出的原始身份材料，原样落 anon_key，不加名字派生前缀。
        anon_key: identity.ip,
        display_name: identity.name || 'Anonymous',
        username: null,
        unix_name: null,
        direction: entry.direction,
      });
    }
  }

  if (quarantined.length > 0) {
    await insertVoteQuarantine(client, pageId, quarantined, observedAt);
  }

  const byOrdinal = new Map<number, number>();
  if (resolvable.length > 0) {
    const rows = await query<{ ordinal: number; voter_id: number }>(
      client,
      'votes:ensure_users',
      `SELECT r.ordinal,
              ingest.ensure_user(
                p_kind         => r.kind,
                p_wikidot_id   => r.wikidot_id,
                p_anon_key     => r.anon_key,
                p_display_name => r.display_name,
                p_username     => r.username,
                p_unix_name    => r.unix_name
              ) AS voter_id
         FROM jsonb_to_recordset($1::jsonb) AS r(
                ordinal int, kind text, wikidot_id int, anon_key text,
                display_name text, username text, unix_name text
              )
        ORDER BY r.ordinal`,
      [toPgJson(resolvable, `votes.users:${pageId}`)],
    );
    for (const row of rows.rows) byOrdinal.set(Number(row.ordinal), Number(row.voter_id));
  }

  const preparedEntries: PreparedVoteSnapshot['entries'] = [];
  const seenVoters = new Set<number>();
  let collisions = 0;
  for (const row of resolvable) {
    const voterId = byOrdinal.get(row.ordinal);
    if (voterId === undefined) {
      throw new Error(`ensure_user 未回显 ordinal=${row.ordinal}`);
    }
    if (seenVoters.has(voterId)) collisions++;
    else seenVoters.add(voterId);
    const parsed = entries.find((entry) => entry.ordinal === row.ordinal);
    if (parsed === undefined) throw new Error(`缺少 ordinal=${row.ordinal} 的解析行`);
    preparedEntries.push({
      voter_id: voterId,
      direction: row.direction,
      source_ordinal: row.ordinal + 1,
      identity_key: parsed.identityKey,
    });
  }

  preparedEntries.sort((a, b) => a.source_ordinal - b.source_ordinal);
  const resultHash = createHash('sha256')
    .update(
      preparedEntries
        .map((entry) =>
          `${entry.source_ordinal}:${entry.voter_id}:${entry.direction}:${entry.identity_key}`,
        )
        .join('\n'),
      'utf8',
    )
    .digest();

  return {
    entries: preparedEntries,
    quarantined: quarantined.length,
    identityCollisions: collisions,
    resultHash,
    // 同一 voter 对应多行正是本模型要保留的来源多重性，不再使快照不完整。
    isComplete: quarantined.length === 0,
  };
}

async function insertVoteQuarantine(
  client: PoolClient,
  pageId: number,
  rows: ReadonlyArray<{ entry: ParsedVoteEntry; reason: string }>,
  observedAt: string,
): Promise<void> {
  await query(
    client,
    'votes:quarantine',
    `INSERT INTO meta.vote_quarantine
       (page_id, voter_key, raw, reason, source, occurred_at)
     SELECT $1, r.voter_key, r.raw, r.reason, 'wikidot', $3::timestamptz
       FROM jsonb_to_recordset($2::jsonb) AS r(voter_key text, raw jsonb, reason text)`,
    [
      pageId,
      toPgJson(
        rows.map(({ entry, reason }) => ({
          voter_key: entry.identityKey,
          raw: entry,
          reason,
        })),
        `votes.quarantine:${pageId}`,
      ),
      toPgTimestamptz(observedAt),
    ],
  );
}

/**
 * 请求/结构解析彻底失败时仍写页级证据；不能因为没有 data 就让该页从 Map/证据表消失。
 */
export async function recordVoteScanFailure(
  pool: Pool,
  target: VoteTarget,
  runId: number | null,
  error: string,
  fetchedTotal: number | null = null,
  checksumActual: number | null = null,
  resultHash: Buffer | null = null,
): Promise<void> {
  await recordPageScan(
    pool,
    {
      runId,
      pageId: target.pageId,
      kind: 'votes',
      status: 'failed',
      claimedTotal: target.claimedTotal,
      fetchedTotal,
      checksumOk: false,
      checksumExpected: target.claimedRating,
      checksumActual,
      resultHash,
      error,
    },
  );
}

/**
 * 确定性矛盾的统一哈希域。payload 不得包含 observed_at、run_id 等轮次材料；
 * 同一份规范化矛盾证据跨轮必须逐字节相同，才能驱动 stable_count 收敛。
 */
export function stableVoteContradictionHash(
  code: string,
  payload: unknown,
): Buffer {
  return createHash('sha256')
    .update(
      JSON.stringify({
        domain: 'syncer2.vote.deterministic_contradiction.v1',
        code,
        payload,
      }),
      'utf8',
    )
    .digest();
}

export function voteSnapshotContradictionHash(
  data: VoteSnapshotData,
  prepared: Pick<
    PreparedVoteSnapshot,
    'entries' | 'quarantined' | 'identityCollisions'
  >,
  scanStatus: Exclude<VoteScanStatus, 'ok'>,
): Buffer {
  return stableVoteContradictionHash('snapshot_gate_mismatch', {
    entries: prepared.entries,
    rawEntries: data.rawEntries,
    parsedUniqueEntries: data.entries.length,
    preparedUniqueEntries: prepared.entries.length,
    duplicateEntries: data.duplicateEntries,
    quarantined: prepared.quarantined,
    identityCollisions: prepared.identityCollisions,
    checksumActual: data.checksum,
    claimedTotal: data.target.claimedTotal,
    claimedRating: data.target.claimedRating,
    scanStatus,
  });
}

function normalizeScanStatus(value: unknown): VoteScanStatus {
  return value === 'ok' || value === 'partial' || value === 'failed' ? value : 'failed';
}

function positiveInt(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value.trim())) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * S1 身份层的纯转换。
 *
 * 这里刻意不碰数据库：dry-run 与正式执行共用同一套转换，避免“预演是一套 SQL、
 * 真跑又是另一套 SQL”。任何清洗都在 page/user 进入 v2 之前完成。
 */

export interface V1PageRow {
  id: number;
  wikidot_id: number;
  url: string;
  current_url: string;
  url_history: string[] | null;
  first_published_at: string | null;
  created_at: string;
}

interface SlugInterval {
  slug: string;
  valid_from: string;
  valid_to: string | null;
}

export interface PagePlan {
  id: number;
  wikidotId: number;
  slugs: SlugInterval[];
  currentSlug: string;
}

type BackfillUserKind = 'wikidot' | 'guest' | 'anon' | 'synthetic';

export interface V1UserRow {
  id: number;
  wikidot_id: number | null;
  display_name: string | null;
  username: string | null;
  is_guest: boolean | null;
  is_collection_synthetic: boolean;
}

export interface UserPlan {
  id: number;
  kind: BackfillUserKind;
  wikidotId: number | null;
  anonKey: string | null;
  username: string | null;
  displayName: string | null;
  usernameIsLegacy: boolean;
}

/**
 * v1 URL → v2 fullname/slug。
 *
 * 权威规格只授权 strip scheme + host；因此这里不会擅自 lower-case、decode、
 * 去 query/hash 或改尾斜杠。`http://host/x` 与 `https://host/x` 都归一成 `x`，
 * 2025-11 legacy 导入的 scheme 指纹不会制造伪改名。
 */
export function normalizeV1Url(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '') throw new Error('URL 为空，不能伪造 fallback slug');

  let remainder = trimmed;
  const absolute = trimmed.match(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*(.*)$/is);
  if (absolute) {
    remainder = absolute[1] ?? '';
  } else {
    const protocolRelative = trimmed.match(/^\/\/[^/?#]*(.*)$/s);
    if (protocolRelative) remainder = protocolRelative[1] ?? '';
  }

  // fullname 不含 host 后的分隔斜杠；只剥分隔符，不改 path 自身的其它字节。
  const slug = remainder.replace(/^\/+/, '');
  if (slug === '') {
    throw new Error(`URL 归一后为空：${JSON.stringify(value)}`);
  }
  return slug;
}

function stableUnique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function toEpochMs(value: string, label: string): number {
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) throw new Error(`${label} 不是合法 UTC 时间：${value}`);
  return epoch;
}

/**
 * 从 url / urlHistory / currentUrl 重建有序 SCD2。
 *
 * v1 的 urlHistory 只有顺序，没有每次改名的时间戳。为了不把 Page.updatedAt（它也会因
 * 非改名元数据更新而变化）冒充改名时刻，这里只表达可证明的顺序：从 firstPublishedAt
 * （缺失则 Page.createdAt）开始，每个相邻历史项递增 1ms。这个 1ms 是迁移排序哨兵，
 * 不是声称真实改名发生在该毫秒；当前项永远最后且 valid_to=NULL。
 */
export function buildPagePlan(row: V1PageRow): PagePlan {
  const currentSlug = normalizeV1Url(row.current_url);
  const orderedRaw = [row.url, ...(row.url_history ?? []), row.current_url];
  const normalized = stableUnique(orderedRaw.map(normalizeV1Url));

  // currentUrl 是当前真相。若历史里曾出现同 slug，移到末尾而不是留下两个重叠区间。
  const historical = normalized.filter((slug) => slug !== currentSlug);
  const slugs = [...historical, currentSlug];
  const baseMs = toEpochMs(row.first_published_at ?? row.created_at, `Page.id=${row.id} 起始时间`);

  return {
    id: row.id,
    wikidotId: row.wikidot_id,
    currentSlug,
    slugs: slugs.map((slug, index) => ({
      slug,
      valid_from: new Date(baseMs + index).toISOString(),
      valid_to: index + 1 < slugs.length ? new Date(baseMs + index + 1).toISOString() : null,
    })),
  };
}

/**
 * v1 四形态 → v2 kind。
 *
 * CollectionAccountOwner 是 BFF 合成行的血统证据，优先于历史 isGuest 标志；
 * 其余无 wikidotId 的稳定 v1 User 行按 isGuest 区分 guest/anon。三类本地身份都用
 * v1 User.id 构造稳定 key，避免同名合并破坏 User.id 一一对应。
 */
export function buildUserPlan(row: V1UserRow): UserPlan {
  let kind: BackfillUserKind;
  let anonKey: string | null;

  if (row.wikidot_id !== null) {
    kind = 'wikidot';
    anonKey = null;
  } else if (row.is_collection_synthetic) {
    kind = 'synthetic';
    anonKey = `synthetic:v1:${row.id}`;
  } else if (row.is_guest === true) {
    kind = 'guest';
    anonKey = `guest:v1:${row.id}`;
  } else {
    kind = 'anon';
    anonKey = `anon:v1-user:${row.id}`;
  }

  return {
    id: row.id,
    kind,
    wikidotId: row.wikidot_id,
    anonKey,
    username: row.username,
    displayName: row.display_name,
    // 这标的是 provenance，不声称每一行都一定伪造；生产实测约 91.8% 命中伪造公式。
    usernameIsLegacy: row.username !== null,
  };
}


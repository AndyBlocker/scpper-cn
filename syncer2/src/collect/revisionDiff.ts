/**
 * PageDiffModule 的可逆源码差量。
 *
 * 上游返回 inline diff：未变化文本是普通文本，旧侧独有文本在 <del>，新侧独有
 * 文本在 <ins>。这里先按与 PageSourceModule 完全相同的实体/<br> 口径还原两侧，
 * 再只保存变化块；大段未变化正文不会进入数据库。
 */

import { createHash } from 'node:crypto';

import { decodeEntities } from '../content/extractText.js';
import { amcRequest } from '../http/amc.js';
import type { HttpClient } from '../http/client.js';
import { throwIfRuntimeBudgetExceeded } from '../util/runtimeBudget.js';
import {
  diagnostics,
  failed,
  ok,
  type CollectResult,
  type PageCollectTarget,
} from './result.js';

export const REVISION_DIFF_PARSER_VERSION = 'inline-v3';

export interface RevisionDiffTarget extends PageCollectTarget {
  fromRevisionId: number;
  toRevisionId: number;
}

export interface RevisionPatchHunk {
  /** JavaScript UTF-16 offset in the old source. Hunks are relative to the unmodified old source. */
  at: number;
  delete: string;
  insert: string;
}

export interface RevisionDiffSnapshot {
  pageId: number;
  wikidotId: number;
  fromRevisionId: number;
  toRevisionId: number;
  fromRevNo: number;
  toRevNo: number;
  beforeOccurredAt: string;
  afterOccurredAt: string;
  beforeTags: string[] | null;
  afterTags: string[] | null;
  sourceChanged: boolean;
  /** sourceChanged=false 时上游不回传源码，二者为 null，由调用方沿用上一版。 */
  beforeSource: string | null;
  afterSource: string | null;
  patch: RevisionPatchHunk[];
  responseSha256Hex: string;
  responseBytes: number;
  /** pilot 覆盖审计；计数来自未解码的 PageDiff HTML。 */
  markupFeatures: {
    gt: number;
    quot: number;
    amp: number;
    nbsp: number;
    br: number;
  };
}

interface TextSegment {
  kind: 'common' | 'delete' | 'insert';
  text: string;
}

function attr(attrs: string, name: string): string | null {
  const m = new RegExp(
    `\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>` + '`' + `]+))`,
    'i',
  ).exec(attrs);
  return m?.[1] ?? m?.[2] ?? m?.[3] ?? null;
}

function classTokens(attrs: string): string[] {
  return (attr(attrs, 'class') ?? '').split(/\s+/).filter(Boolean);
}

function stripHtml(html: string): string {
  return decodeEntities(
    html
      .replace(/<br\b[^>]*\/?>/gi, '\n')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\u00a0/g, ' ')
    .trim();
}

function splitCells(rowHtml: string): string[] {
  const starts = [...rowHtml.matchAll(/<td\b[^>]*>/gi)];
  return starts.map((m, i) => {
    const start = (m.index ?? 0) + m[0].length;
    const end =
      i + 1 < starts.length ? (starts[i + 1]!.index ?? rowHtml.length) : rowHtml.length;
    return rowHtml.slice(start, end).replace(/<\/td>\s*$/i, '');
  });
}

function parseTags(body: string): [string[] | null, string[] | null] {
  for (const row of body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)) {
    const cells = splitCells(row[1] ?? '');
    if (cells.length < 3 || stripHtml(cells[0] ?? '').replace(/\s+/g, '') !== '标签:') continue;
    return [tagList(cells[1] ?? ''), tagList(cells[2] ?? '')];
  }
  return [null, null];
}

function tagList(cell: string): string[] {
  const text = stripHtml(cell).replace(/\s+/g, ' ').trim();
  return text === '' ? [] : [...new Set(text.split(' ').filter(Boolean))];
}

function normalizeSource(value: string): string {
  // 与 collect/source.ts fragmentText() 的最终规范化保持一致。
  return value.replace(/\u00a0/g, ' ').trim().replace(/^\t/, '');
}

function inlineDiffInner(body: string): string | null {
  // 不能用一个非贪婪 `<div>...</div>` 正则从文档头开始迭代：外层 diff-box
  // 会先吞到 inline-diff 的闭标签，导致嵌套容器永远没有独立 match。
  const re = /<div\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const classes = classTokens(m[1] ?? '');
    if (!classes.includes('inline-diff') || !classes.includes('page-source')) continue;
    const end = body.slice(re.lastIndex).search(/<\/div\s*>/i);
    if (end < 0) return null;
    return body.slice(re.lastIndex, re.lastIndex + end);
  }
  return null;
}

function parseInlineSegments(innerHtml: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let mode: TextSegment['kind'] = 'common';
  const lineChangeKinds = new Set<'delete' | 'insert'>();
  const multilineChangeKinds = new Set<'delete' | 'insert'>();
  const nonEmptyChangeKinds = new Set<'delete' | 'insert'>();
  let changedLineTail: 'delete' | 'insert' | null = null;
  let cursor = 0;
  const token =
    /<!--[\s\S]*?-->|<\/?(?:del|ins)\b[^>]*>|<br\b[^>]*\/?>|<[^>]+>/gi;
  let m: RegExpExecArray | null;

  const push = (kind: TextSegment['kind'], raw: string): void => {
    if (raw === '') return;
    const text = decodeEntities(raw.replace(/&nbsp;/gi, ' ')).replace(/\u00a0/g, ' ');
    if (text === '') return;
    if (kind !== 'common') nonEmptyChangeKinds.add(kind);
    const last = segments.at(-1);
    if (last?.kind === kind) last.text += text;
    else segments.push({ kind, text });
  };

  const pushRaw = (raw: string): void => {
    if (changedLineTail !== null) {
      // 多行 <ins>/<del> 把最后一条 changed-side 换行放在闭标签之后：
      //   <ins>new-1<br />\nnew-2<br />\n</ins><br />\nnext
      // “块内已经出现过 br”的多行 change 与表示空行的空 change 使用这个口径；
      // 单行非空 <ins>x</ins><br /> 的外置 br 是两侧共有的行终止符。
      const leading = /^\s+/.exec(raw)?.[0] ?? '';
      if (leading !== '') push(changedLineTail, leading);
      raw = raw.slice(leading.length);
      changedLineTail = null;
      lineChangeKinds.clear();
      multilineChangeKinds.clear();
      nonEmptyChangeKinds.clear();
    }
    if (raw === '') return;
    push(mode, raw);
    if (mode === 'common' && /\S/.test(raw)) {
      lineChangeKinds.clear();
      multilineChangeKinds.clear();
      nonEmptyChangeKinds.clear();
    }
  };

  while ((m = token.exec(innerHtml)) !== null) {
    pushRaw(innerHtml.slice(cursor, m.index));
    const markup = m[0];
    if (/^<del\b/i.test(markup)) {
      mode = 'delete';
      lineChangeKinds.add('delete');
    }
    else if (/^<\/del\b/i.test(markup)) mode = 'common';
    else if (/^<ins\b/i.test(markup)) {
      mode = 'insert';
      lineChangeKinds.add('insert');
    }
    else if (/^<\/ins\b/i.test(markup)) mode = 'common';
    else if (/^<br\b/i.test(markup)) {
      if (mode !== 'common') {
        multilineChangeKinds.add(mode);
        push(mode, '\n');
      } else if (lineChangeKinds.size === 1) {
        const changedSide = [...lineChangeKinds][0]!;
        if (
          multilineChangeKinds.has(changedSide) ||
          !nonEmptyChangeKinds.has(changedSide)
        ) {
          // 空 <ins></ins><br /> / <del></del><br /> 明确表示新增/删除一个空行，
          // 外置 br 也只属于变化侧。
          changedLineTail = changedSide;
          push(changedSide, '\n');
        } else {
          // 单行 change 没有把自己的行终止符包进标签；外置 br 属于两侧。
          push('common', '\n');
          lineChangeKinds.clear();
          multilineChangeKinds.clear();
          nonEmptyChangeKinds.clear();
        }
      } else {
        push(mode, '\n');
        lineChangeKinds.clear();
        multilineChangeKinds.clear();
        nonEmptyChangeKinds.clear();
      }
    }
    // 注释及其它真实包装标签丢弃；实体解码在删标签之后，源码里的 &lt;x&gt; 不会被误删。
    cursor = token.lastIndex;
  }
  pushRaw(innerHtml.slice(cursor));
  if (mode !== 'common') throw new Error(`inline diff 的 <del>/<ins> 未闭合（末态=${mode}）`);
  return segments;
}

function sourcesAndAnnotatedPatch(segments: readonly TextSegment[]): {
  before: string;
  after: string;
  patch: RevisionPatchHunk[];
} {
  let beforeRaw = '';
  let afterRaw = '';
  let oldOffset = 0;
  let pending: RevisionPatchHunk | null = null;
  const patch: RevisionPatchHunk[] = [];

  const flush = (): void => {
    if (pending !== null) {
      if (pending.delete !== '' || pending.insert !== '') patch.push(pending);
      pending = null;
    }
  };

  for (const segment of segments) {
    if (segment.kind === 'common') {
      flush();
      beforeRaw += segment.text;
      afterRaw += segment.text;
      oldOffset += segment.text.length;
      continue;
    }
    pending ??= { at: oldOffset, delete: '', insert: '' };
    if (segment.kind === 'delete') {
      pending.delete += segment.text;
      beforeRaw += segment.text;
      oldOffset += segment.text.length;
    } else {
      pending.insert += segment.text;
      afterRaw += segment.text;
    }
  }
  flush();

  const before = normalizeSource(beforeRaw);
  const after = normalizeSource(afterRaw);
  try {
    if (applyRevisionPatch(before, patch, 'forward') === after) return { before, after, patch };
  } catch {
    // 包装缩进或源码首尾空白落在 <ins>/<del> 内时，规范化会改变首尾 offset。
  }
  const fallback = singleSplicePatch(before, after);
  return { before, after, patch: fallback };
}

function singleSplicePatch(before: string, after: string): RevisionPatchHunk[] {
  if (before === after) return [];
  let prefix = 0;
  while (
    prefix < before.length &&
    prefix < after.length &&
    before.charCodeAt(prefix) === after.charCodeAt(prefix)
  ) {
    prefix++;
  }
  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (
    beforeEnd > prefix &&
    afterEnd > prefix &&
    before.charCodeAt(beforeEnd - 1) === after.charCodeAt(afterEnd - 1)
  ) {
    beforeEnd--;
    afterEnd--;
  }
  return [
    {
      at: prefix,
      delete: before.slice(prefix, beforeEnd),
      insert: after.slice(prefix, afterEnd),
    },
  ];
}

export function applyRevisionPatch(
  source: string,
  hunks: readonly RevisionPatchHunk[],
  direction: 'forward' | 'backward' = 'forward',
): string {
  const normalized = hunks.map((hunk) => ({ ...hunk }));
  for (let i = 0; i < normalized.length; i++) {
    const hunk = normalized[i]!;
    if (!Number.isSafeInteger(hunk.at) || hunk.at < 0) {
      throw new Error(`patch hunk[${i}] at 非法：${hunk.at}`);
    }
    if (i > 0) {
      const prev = normalized[i - 1]!;
      if (hunk.at < prev.at + prev.delete.length) {
        throw new Error(`patch hunk[${i}] 与前一块重叠`);
      }
    }
  }

  let output = source;
  if (direction === 'forward') {
    for (const hunk of [...normalized].reverse()) {
      if (output.slice(hunk.at, hunk.at + hunk.delete.length) !== hunk.delete) {
        throw new Error(`forward patch 在 offset=${hunk.at} 的删除串不匹配`);
      }
      output =
        output.slice(0, hunk.at) + hunk.insert + output.slice(hunk.at + hunk.delete.length);
    }
    return output;
  }

  let delta = 0;
  const reverse = normalized.map((hunk) => {
    const at = hunk.at + delta;
    delta += hunk.insert.length - hunk.delete.length;
    return { at, delete: hunk.insert, insert: hunk.delete };
  });
  for (const hunk of reverse.reverse()) {
    if (output.slice(hunk.at, hunk.at + hunk.delete.length) !== hunk.delete) {
      throw new Error(`backward patch 在 offset=${hunk.at} 的删除串不匹配`);
    }
    output =
      output.slice(0, hunk.at) + hunk.insert + output.slice(hunk.at + hunk.delete.length);
  }
  return output;
}

export function revisionDiffRequestParams(
  target: RevisionDiffTarget,
): Record<string, string | number> {
  return {
    page_id: target.wikidotId,
    from_revision_id: target.fromRevisionId,
    to_revision_id: target.toRevisionId,
  };
}

export function parseRevisionDiffBody(
  body: string,
  target: RevisionDiffTarget,
): CollectResult<RevisionDiffSnapshot> {
  if (!/<div\b[^>]*class\s*=\s*["'][^"']*\bdiff-box\b/i.test(body)) {
    return failed('PageDiffModule 响应中没有 div.diff-box。', diagnostics(1, 0));
  }
  if (!/<table\b[^>]*class\s*=\s*["'][^"']*\bpage-compare\b/i.test(body)) {
    return failed('PageDiffModule 响应中没有 table.page-compare。', diagnostics(1, 0));
  }

  const revNos = [...body.matchAll(/<th\b[^>]*>\s*修订版本\s+(\d+)\s*<\/th>/gi)].map((m) =>
    Number(m[1]),
  );
  const epochs = [...body.matchAll(/\btime_(\d{9,12})\b/g)].map((m) => Number(m[1]));
  if (
    revNos.length !== 2 ||
    epochs.length < 2 ||
    revNos.some((v) => !Number.isSafeInteger(v) || v < 0) ||
    epochs.slice(0, 2).some((v) => !Number.isFinite(v) || v <= 0)
  ) {
    return failed(
      `PageDiffModule 两侧元数据不完整：revNos=${JSON.stringify(revNos)} epochs=${JSON.stringify(epochs.slice(0, 3))}`,
      diagnostics(1, 0),
    );
  }

  const [beforeTags, afterTags] = parseTags(body);
  const inner = inlineDiffInner(body);
  const saysSame = /页面源代码相同/.test(stripHtml(body));
  if (inner === null && !saysSame) {
    return failed(
      'PageDiffModule 既没有 div.inline-diff.page-source，也没有“页面源代码相同”标记。',
      diagnostics(1, 0),
    );
  }

  try {
    const parsed =
      inner === null
        ? { before: null, after: null, patch: [] as RevisionPatchHunk[] }
        // 先剥模块模板在容器内侧添加的换行/缩进；PageSource 解析最终同样 `.trim()`。
        // 若真实源码首尾空白恰好落在 del/ins 内，下面的双向自校验会触发精确 fallback。
        : sourcesAndAnnotatedPatch(parseInlineSegments(inner.trim()));
    if (
      parsed.before !== null &&
      parsed.after !== null &&
      (applyRevisionPatch(parsed.before, parsed.patch, 'forward') !== parsed.after ||
        applyRevisionPatch(parsed.after, parsed.patch, 'backward') !== parsed.before)
    ) {
      return failed('inline diff 生成的 patch 未通过双向逐字节自校验。', diagnostics(1, 0));
    }
    return ok(
      {
        pageId: target.pageId,
        wikidotId: target.wikidotId,
        fromRevisionId: target.fromRevisionId,
        toRevisionId: target.toRevisionId,
        fromRevNo: revNos[0]!,
        toRevNo: revNos[1]!,
        beforeOccurredAt: new Date(epochs[0]! * 1_000).toISOString(),
        afterOccurredAt: new Date(epochs[1]! * 1_000).toISOString(),
        beforeTags,
        afterTags,
        sourceChanged: inner !== null,
        beforeSource: parsed.before,
        afterSource: parsed.after,
        patch: parsed.patch,
        responseSha256Hex: createHash('sha256').update(body, 'utf8').digest('hex'),
        responseBytes: Buffer.byteLength(body, 'utf8'),
        markupFeatures: {
          gt: (body.match(/&gt;/gi) ?? []).length,
          quot: (body.match(/&quot;/gi) ?? []).length,
          amp: (body.match(/&amp;/gi) ?? []).length,
          nbsp: (body.match(/&nbsp;/gi) ?? []).length,
          br: (body.match(/<br\b[^>]*\/?>/gi) ?? []).length,
        },
      },
      diagnostics(1, 1),
    );
  } catch (err) {
    return failed(`inline diff 解析失败：${String(err)}`, diagnostics(1, 0));
  }
}

export async function fetchRevisionDiff(
  http: HttpClient,
  baseUrl: string,
  target: RevisionDiffTarget,
): Promise<CollectResult<RevisionDiffSnapshot>> {
  try {
    const res = await amcRequest(http, baseUrl, {
      moduleName: 'history/PageDiffModule',
      params: revisionDiffRequestParams(target),
      mode: 'tier2:revision-source-diff',
      maxAttempts: 3,
    });
    if (res.status !== 'ok') {
      return failed(
        `PageDiffModule status=${res.status}（message=${res.message ?? '-'}）`,
        diagnostics(1, 0),
      );
    }
    if (res.body === null) {
      return failed('PageDiffModule status=ok 但 body 缺失。', diagnostics(1, 0));
    }
    return parseRevisionDiffBody(res.body, target);
  } catch (err) {
    throwIfRuntimeBudgetExceeded(err);
    return failed(`PageDiffModule 请求失败：${String(err)}`, diagnostics(1, 0));
  }
}

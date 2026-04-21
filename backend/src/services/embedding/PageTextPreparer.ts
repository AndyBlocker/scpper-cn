/**
 * Prepare one PageVersion for chunk-level embedding.
 *
 * Output is a list of chunks (>=1). Each chunk carries:
 *   - 和整页共享的 header（title / alt / category / tags）
 *   - 正文的某一段（char 粒度滑窗 + overlap）
 *   - 段在整页原文中的 [start, end) 字符范围（便于后续高亮/跳转）
 *
 * 为什么按字符而不是 token 切：
 *   1. 不需要在 Node 端引入 tokenizer（不想额外装 transformers/tokenizer 原生包）
 *   2. 中文下 char ≈ token，英文混合也只差 2-3x，embedding 模型自己会在末端截
 *   3. overlap 只需要粗略"跨段连续"，不需要精确 token 对齐
 */

export interface PageTextInput {
  title: string | null;
  alternateTitle: string | null;
  category: string | null;
  tags: string[] | null;
  textContent: string | null;
}

export interface PreparedChunk {
  /** 实际喂给模型的完整字符串（header + content slice） */
  text: string;
  /** 字符长度（含 header），作为 sourceCharLen 存库 */
  sourceCharLen: number;
  /** 这个 chunk 对应的正文 char 范围 [start, end) */
  contentStart: number;
  contentEnd: number;
  /** 从 0 开始；同一 PV 的 chunk 序号 */
  chunkIndex: number;
  /** 这个 PV 的总 chunk 数（chunks[i].chunkTotal 对所有 i 相同） */
  chunkTotal: number;
  /** 尾部是否被 BGE-M3 截掉（chunk 本身 > 模型 max_seq 时发生，目前几乎不会） */
  truncated: boolean;
}

/** Chunk 大小 / overlap / 上限。对 BGE-M3 (8K token ~ 8K char on 中文) 是安全值。 */
const CHUNK_SIZE = 1500;
const CHUNK_OVERLAP = 200;
const HEADER_BUDGET = 600;
/** 硬上限：即使 header + chunk 超过 model max_seq，server 端会再截一次。 */
const MODEL_MAX_CHARS = 7500;
/** 每篇最多切几段；过长页（如 85K char hub）截断到 MAX_CHUNKS × CHUNK_SIZE。 */
const MAX_CHUNKS = 16;

const WIKIDOT_NOISE_PATTERNS: RegExp[] = [
  /\[\[include[^\]]*\]\]/gi,
  /\[\[\/?module[^\]]*\]\]/gi,
  /\[\[\/?div[^\]]*\]\]/gi,
  /\[\[\/?span[^\]]*\]\]/gi,
  /\[\[\/?size[^\]]*\]\]/gi,
  /\[\[\/?a[^\]]*\]\]/gi,
  /\[\[\/?collapsible[^\]]*\]\]/gi,
  /\[\[\/?iframe[^\]]*\]\]/gi,
  /\[\[\/?image[^\]]*\]\]/gi,
  /\[\[\/?footnoteblock[^\]]*\]\]/gi,
  /\[\[\/?footnote[^\]]*\]\]/gi,
  /\[\[\/?bibliography[^\]]*\]\]/gi
];

function denoise(raw: string): string {
  let s = raw;
  for (const re of WIKIDOT_NOISE_PATTERNS) {
    s = s.replace(re, ' ');
  }
  s = s.replace(/\t+/g, ' ').replace(/[  ]{2,}/g, ' ');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

function buildHeader(input: PageTextInput): string {
  const h: string[] = [];
  if (input.title) h.push(`标题: ${input.title}`);
  if (input.alternateTitle && input.alternateTitle !== input.title) {
    h.push(`别名: ${input.alternateTitle}`);
  }
  if (input.category) h.push(`分类: ${input.category}`);
  const tags = (input.tags ?? []).filter(t => t && !t.startsWith('_')).slice(0, 32);
  if (tags.length) h.push(`标签: ${tags.join(', ')}`);
  return h.join('\n');
}

export function preparePageChunks(input: PageTextInput): PreparedChunk[] {
  const header = buildHeader(input);
  const headerForChunk = header.length > HEADER_BUDGET
    ? header.slice(0, HEADER_BUDGET)
    : header;
  const body = denoise(input.textContent || '');

  // 极短页或完全无正文：只 embed header。仍产出 1 个 chunk（长度为 0 的正文段）。
  if (!body) {
    if (!headerForChunk) {
      return [];
    }
    return [
      {
        text: headerForChunk,
        sourceCharLen: headerForChunk.length,
        contentStart: 0,
        contentEnd: 0,
        chunkIndex: 0,
        chunkTotal: 1,
        truncated: false
      }
    ];
  }

  // 切段：滑窗 [i, i + CHUNK_SIZE)，下一段从 i + CHUNK_SIZE - CHUNK_OVERLAP 开始
  const step = CHUNK_SIZE - CHUNK_OVERLAP;
  const rawChunks: Array<{ start: number; end: number }> = [];
  for (let start = 0; start < body.length; start += step) {
    const end = Math.min(start + CHUNK_SIZE, body.length);
    rawChunks.push({ start, end });
    if (end === body.length) break;
    if (rawChunks.length >= MAX_CHUNKS) break;
  }

  const total = rawChunks.length;
  const chunks: PreparedChunk[] = rawChunks.map((c, idx) => {
    const bodySlice = body.slice(c.start, c.end);
    // header + 正文片段 + chunk 序号提示（帮助模型区分"这是第几段"）
    const segTag = total > 1 ? `\n[段 ${idx + 1}/${total}]\n` : '\n\n';
    const composed = `${headerForChunk}${segTag}${bodySlice}`;
    const truncated = composed.length > MODEL_MAX_CHARS;
    return {
      text: truncated ? composed.slice(0, MODEL_MAX_CHARS) : composed,
      sourceCharLen: truncated ? MODEL_MAX_CHARS : composed.length,
      contentStart: c.start,
      contentEnd: c.end,
      chunkIndex: idx,
      chunkTotal: total,
      truncated
    };
  });

  return chunks;
}

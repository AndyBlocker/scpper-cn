/**
 * Build the input text fed to the embedding model for one PageVersion.
 *
 * Structure:
 *   标题: <title>
 *   别名: <alternateTitle>         (optional)
 *   分类: <category>               (optional)
 *   标签: <tags joined>            (optional)
 *
 *   <textContent, trimmed/truncated>
 *
 * Truncation rule: BGE-M3 allows 8192 tokens. For Chinese text ~1 char = 1 token
 * (most CJK codepoints tokenize as 1 piece). We keep an 8000-char safety cap on
 * the final composed string. Longer inputs get trimmed at the end of textContent
 * and `truncated=true` is reported so the caller can log it for downstream QA.
 */

export interface PageTextInput {
  title: string | null;
  alternateTitle: string | null;
  category: string | null;
  tags: string[] | null;
  textContent: string | null;
}

export interface PreparedPageText {
  text: string;
  sourceCharLen: number;
  truncated: boolean;
}

const MAX_FINAL_CHARS = 8000;
const HEADER_BUDGET = 600; // tags + category + title rarely exceed this; reserve

// 粗清洗：Wikidot 源码片段会有 [[include]] / [[module]] / [[div ...]] 噪音；
// 我们只是做 embedding，把这类语法标记剥掉能让相似度比对更纯。
// 不尝试完整渲染 — 只是减噪。
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
  // 折叠空白（换行保留一次用于分段）
  s = s.replace(/\t+/g, ' ').replace(/[  ]{2,}/g, ' ');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

export function preparePageText(input: PageTextInput): PreparedPageText {
  const header: string[] = [];
  if (input.title) header.push(`标题: ${input.title}`);
  if (input.alternateTitle && input.alternateTitle !== input.title) {
    header.push(`别名: ${input.alternateTitle}`);
  }
  if (input.category) header.push(`分类: ${input.category}`);
  const tagsTrimmed = (input.tags ?? []).filter(t => t && !t.startsWith('_')).slice(0, 32);
  if (tagsTrimmed.length) header.push(`标签: ${tagsTrimmed.join(', ')}`);

  const headerText = header.join('\n');
  const contentBudget = Math.max(0, MAX_FINAL_CHARS - Math.min(headerText.length, HEADER_BUDGET) - 4);
  const body = denoise(input.textContent || '');
  const truncated = body.length > contentBudget;
  const bodyTrimmed = truncated ? body.slice(0, contentBudget) : body;

  const composed = bodyTrimmed
    ? `${headerText}\n\n${bodyTrimmed}`
    : headerText;

  return {
    text: composed,
    sourceCharLen: composed.length,
    truncated
  };
}

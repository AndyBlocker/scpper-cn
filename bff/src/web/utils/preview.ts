// Simple preview block parser for SCPPER_CN_PREVIEW markers
// Syntax examples supported:
//   SCPPER_CN_PREVIEW_BEGIN ... SCPPER_CN_PREVIEW_END
//   SCPPER_CN_PREVIEW_BEGIN(meta: ... ) ... SCPPER_CN_PREVIEW_END
//   Content may be wrapped by /* ... */ or { ... } and will be unwrapped.

export type PreviewPick = {
  text: string;
  html: string;
};

const BLOCK_RE = /SCPPER_CN_PREVIEW_BEGIN(?:\([^)]*\))?([\s\S]*?)SCPPER_CN_PREVIEW_END/gi;
// Matches an [[include ...]] block (multiline, case-insensitive)
const INCLUDE_BLOCK_RE = /\[\[\s*include\b([\s\S]*?)\]\]/gi;
// Detect target path that resolves to scpper-tracking-module in various forms:
//   - component:scpper-tracking-module
//   - :scp-wiki-cn:components:scpper-tracking-module
//   - components:scpper-tracking-module
const TARGET_RE = /(?:\bcomponent\s*:\s*|:\s*[a-z0-9_-]+\s*:\s*components?\s*:\s*|\bcomponents?\s*:\s*)scpper-tracking-module\b/i;

function unwrap(content: string): string {
  let s = content.trim();
  // unwrap /* ... */
  const cm = s.match(/^\/\*([\s\S]*?)\*\/$/);
  if (cm && cm[1]) s = cm[1].trim();
  // unwrap { ... }
  const bm = s.match(/^\{([\s\S]*?)\}$/);
  if (bm && bm[1]) s = bm[1].trim();
  // unwrap [[!-- ... --]] style comments
  const wm = s.match(/^\[\[!+[-]{0,2}\s*([\s\S]*?)\s*[-]{0,2}\]\]$/);
  if (wm && wm[1]) s = wm[1].trim();
  return s;
}

export function extractPreviewCandidates(source?: string | null): string[] {
  // 1) Prefer include parameter scpper-preview
  const includeItems = extractPreviewFromInclude(source);
  if (includeItems.length > 0) return includeItems;

  // 2) Fallback to legacy SCPPER_CN_PREVIEW markers
  if (typeof source !== 'string' || source.length === 0) return [];
  const items: string[] = [];
  let m: RegExpExecArray | null;
  BLOCK_RE.lastIndex = 0;
  while ((m = BLOCK_RE.exec(source)) !== null) {
    const raw = (m[1] || '').toString();
    const unwrapped = unwrap(raw);
    const cleaned = cleanPreviewText(unwrapped);
    if (cleaned) items.push(cleaned);
    // avoid infinite loop on zero-length matches
    if (m.index === BLOCK_RE.lastIndex) BLOCK_RE.lastIndex++;
  }
  return items;
}

function cleanPreviewText(s: string): string {
  return s
    .replace(/\r/g, '')
    .replace(/\t/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function extractPreviewFromInclude(source?: string | null): string[] {
  if (typeof source !== 'string' || source.length === 0) return [];
  const items: string[] = [];

  let m: RegExpExecArray | null;
  INCLUDE_BLOCK_RE.lastIndex = 0;
  while ((m = INCLUDE_BLOCK_RE.exec(source)) !== null) {
    const body = (m[1] || '').toString();
    // Split head (target) and params by first '|'
    const sep = body.indexOf('|');
    const head = (sep >= 0 ? body.slice(0, sep) : body).replace(/\r/g, '').trim();
    if (!TARGET_RE.test(head)) {
      // Not our tracking component
      continue;
    }
    const params = sep >= 0 ? body.slice(sep + 1) : '';
    if (!params) continue;
    // Split by '|' — spec disallows '|' in scpper-preview value, so safe
    const parts = params.split('|');
    for (const rawPart of parts) {
      const part = rawPart.replace(/\r/g, '').trim();
      if (!part) continue;
      const m2 = part.match(/^scpper-preview\s*=\s*([\s\S]*)$/i);
      if (m2) {
        const val = cleanPreviewText(m2[1] || '');
        if (val) items.push(val);
      }
    }
    // avoid infinite loop on zero-length matches
    if (m.index === INCLUDE_BLOCK_RE.lastIndex) INCLUDE_BLOCK_RE.lastIndex++;
  }
  return items;
}

function hashSeed(seed: string): number {
  // DJB2-like
  let h = 5381;
  for (let i = 0; i < seed.length; i++) h = ((h << 5) + h) ^ seed.charCodeAt(i);
  return Math.abs(h >>> 0);
}

export function pickPreview(items: string[], seed?: string | number): string | null {
  if (!Array.isArray(items) || items.length === 0) return null;
  if (seed == null) {
    const idx = Math.floor(Math.random() * items.length);
    return items[idx] || null;
  }
  const n = typeof seed === 'number' ? Math.abs(seed) : hashSeed(String(seed));
  const idx = n % items.length;
  return items[idx] || null;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function toPreviewPick(text: string): PreviewPick {
  const trimmed = text.trim();
  const html = escapeHtml(trimmed).replace(/\n/g, '<br>');
  return { text: trimmed, html };
}

// Fallback excerpt extraction used when no explicit preview is available.
// Mirrors homepage random logic:
//  - Strip lightweight markup and list markers
//  - Collapse whitespace
//  - Split into sentences while preserving ending punctuation
//  - Pick a random sentence, truncate to maxLength with ellipsis
export function extractExcerptFallback(textContent: string | null | undefined, maxLength = 150): string {
  if (!textContent || String(textContent).trim() === '') return '';
  const cleanText = String(textContent)
    .replace(/\[\[[^\]]*\]\]/g, '') // remove [[...]]
    .replace(/\{\{[^}]*\}\}/g, '')   // remove {{...}}
    .replace(/^[#*\-+>|\s]+/gm, '')    // remove list/quote markers
    .replace(/\n+/g, ' ')               // newlines -> space
    .replace(/\s{2,}/g, ' ')            // collapse spaces
    .trim();
  if (!cleanText) return '';
  const sentences = (cleanText.match(/[^。！？.!?]+[。！？.!?]+/g) || [])
    .map(s => s.trim())
    .filter(s => s.length > 20);
  const chosen = sentences.length > 0
    ? sentences[Math.floor(Math.random() * sentences.length)]
    : cleanText;
  if (chosen.length <= maxLength) return chosen;
  return chosen.slice(0, Math.max(0, maxLength - 3)) + '...';
}

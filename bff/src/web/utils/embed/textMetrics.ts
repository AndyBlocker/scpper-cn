/**
 * Rough text-width estimation for shields-style SVG badges.
 *
 * Shields.io ships a full Verdana glyph-width table; we only need a cheap
 * approximation that keeps Latin / digit / CJK / symbol labels aligned.
 */

const LATIN_NARROW = new Set('ijlI.,:;!|\'`"'.split(''));
const LATIN_WIDE = new Set('MWmw@#%&'.split(''));

function codeUnitWidth(ch: string): number {
  const code = ch.charCodeAt(0);
  // CJK Unified Ideographs, Hangul, Hiragana, Katakana, full-width
  if (
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0xff00 && code <= 0xffef)
  ) {
    return 12;
  }
  if (code < 0x20) return 0;
  if (LATIN_NARROW.has(ch)) return 4;
  if (LATIN_WIDE.has(ch)) return 9;
  if (ch >= '0' && ch <= '9') return 6.5;
  if (ch >= 'A' && ch <= 'Z') return 7.5;
  if (ch >= 'a' && ch <= 'z') return 6.5;
  return 6;
}

export function estimateTextWidth(text: string): number {
  if (!text) return 0;
  let width = 0;
  for (const ch of text) {
    width += codeUnitWidth(ch);
  }
  return Math.ceil(width);
}

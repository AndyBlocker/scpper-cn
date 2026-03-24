/**
 * Shared helper functions used across multiple BFF route modules.
 */

/**
 * Parse a value as a positive integer (> 0). Returns null if invalid.
 */
export function parsePositiveInt(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

/**
 * Extract a plain-text excerpt from wiki/HTML content.
 * Strips markup, picks a random sentence, and truncates to maxLength.
 */
export function extractExcerpt(textContent: string | null | undefined, maxLength = 160): string | null {
  if (!textContent) return null;
  const cleanText = String(textContent)
    .replace(/\[\[[^\]]*\]\]/g, '')
    .replace(/\{\{[^}]*\}\}/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/^[#*\-+>|\s]+/gm, '')
    .replace(/\n+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (!cleanText) return null;

  const sentences = (cleanText.match(/[^。！？.!?]+[。！？.!?]+/g) || [])
    .map((s) => s.trim())
    .filter((s) => s.length > 12);
  const chosen = sentences.length > 0 ? sentences[Math.floor(Math.random() * sentences.length)] : cleanText;
  const normalized = chosen.trim();
  if (!normalized) return null;

  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

/**
 * Escape HTML special characters to prevent XSS.
 */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

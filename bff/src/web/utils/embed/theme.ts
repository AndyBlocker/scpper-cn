export type EmbedTheme = 'auto' | 'light' | 'dark';

export interface ResolvedTheme {
  theme: EmbedTheme;
  accent: string;
}

/**
 * 把 theme / accent 参数标准化。accent 接受 3/6/8 位 hex（可带或不带 #），fallback 到 SCPPER
 * 默认强调色。非法输入一律回退，不抛错，与 inlineCss 的"装饰失败即沉默"保持一致。
 */
export function resolveTheme(rawTheme: unknown, rawAccent: unknown): ResolvedTheme {
  const t = typeof rawTheme === 'string' ? rawTheme.toLowerCase() : 'auto';
  const theme: EmbedTheme = t === 'dark' || t === 'light' ? t : 'auto';

  const defaultAccent = '#6f4ef2';
  let accent = defaultAccent;
  if (typeof rawAccent === 'string') {
    const trimmed = rawAccent.trim().replace(/^#/, '');
    if (/^[0-9a-fA-F]{3}$/.test(trimmed) || /^[0-9a-fA-F]{6}$/.test(trimmed) || /^[0-9a-fA-F]{8}$/.test(trimmed)) {
      accent = `#${trimmed}`;
    }
  }

  return { theme, accent };
}

/**
 * 设计 token 统一命名规则：
 *   表面：--e-bg / --e-surface / --e-surface-raised
 *   边框：--e-border / --e-border-strong
 *   文字：--e-fg / --e-fg-muted / --e-fg-subtle
 *   品牌：--e-accent / --e-accent-soft / --e-accent-strong
 *   语义：--e-good / --e-warn / --e-bad
 *
 * 旧命名（--e-text / --e-text-muted / --e-text-subtle）作为向后兼容 alias 保留，
 * 方便历史 CSS 覆写仍然生效；新模板请只使用新命名。
 */
export function buildThemeCss({ theme, accent }: ResolvedTheme): string {
  const lightVars = `
    --e-bg: #ffffff;
    --e-surface: #f7f7f8;
    --e-surface-raised: #eef0f4;
    --e-border: #e5e7eb;
    --e-border-strong: #d1d5db;
    --e-fg: #111827;
    --e-fg-muted: #6b7280;
    --e-fg-subtle: #9ca3af;
    --e-accent: ${accent};
    --e-accent-soft: color-mix(in srgb, ${accent} 16%, transparent);
    --e-accent-strong: color-mix(in srgb, ${accent} 75%, #000);
    --e-good: #059669;
    --e-warn: #d97706;
    --e-bad: #dc2626;
    --e-text: var(--e-fg);
    --e-text-muted: var(--e-fg-muted);
    --e-text-subtle: var(--e-fg-subtle);
  `;
  const darkVars = `
    --e-bg: #0b0b0f;
    --e-surface: #16161c;
    --e-surface-raised: #1e1e26;
    --e-border: #26262e;
    --e-border-strong: #353540;
    --e-fg: #f5f5f5;
    --e-fg-muted: #a1a1aa;
    --e-fg-subtle: #71717a;
    --e-accent: ${accent};
    --e-accent-soft: color-mix(in srgb, ${accent} 22%, transparent);
    --e-accent-strong: color-mix(in srgb, ${accent} 80%, #ffffff);
    --e-good: #34d399;
    --e-warn: #fbbf24;
    --e-bad: #f87171;
    --e-text: var(--e-fg);
    --e-text-muted: var(--e-fg-muted);
    --e-text-subtle: var(--e-fg-subtle);
  `;

  if (theme === 'light') return `:root { ${lightVars} }`;
  if (theme === 'dark') return `:root { ${darkVars} }`;
  return `:root { ${lightVars} }
    @media (prefers-color-scheme: dark) {
      :root { ${darkVars} }
    }`;
}

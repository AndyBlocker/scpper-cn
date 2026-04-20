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
 * 注：light / dark 变量名和前端 `:root` / `.dark` 上定义的设计系统同源，
 * 方便用户的自定义 CSS 用同一套变量覆写。
 */
export function buildThemeCss({ theme, accent }: ResolvedTheme): string {
  const lightVars = `
    --e-bg: #ffffff;
    --e-surface: #f7f7f8;
    --e-border: #e5e7eb;
    --e-text: #111827;
    --e-text-muted: #6b7280;
    --e-text-subtle: #9ca3af;
    --e-accent: ${accent};
    --e-accent-soft: color-mix(in srgb, ${accent} 16%, transparent);
    --e-good: #059669;
    --e-warn: #d97706;
    --e-bad: #dc2626;
  `;
  const darkVars = `
    --e-bg: #0b0b0f;
    --e-surface: #16161c;
    --e-border: #26262e;
    --e-text: #f5f5f5;
    --e-text-muted: #a1a1aa;
    --e-text-subtle: #71717a;
    --e-accent: ${accent};
    --e-accent-soft: color-mix(in srgb, ${accent} 22%, transparent);
    --e-good: #34d399;
    --e-warn: #fbbf24;
    --e-bad: #f87171;
  `;

  if (theme === 'light') return `:root { ${lightVars} }`;
  if (theme === 'dark') return `:root { ${darkVars} }`;
  return `:root { ${lightVars} }
    @media (prefers-color-scheme: dark) {
      :root { ${darkVars} }
    }`;
}

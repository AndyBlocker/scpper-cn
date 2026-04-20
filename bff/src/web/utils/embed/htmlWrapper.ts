import type { Response } from 'express';
import { buildThemeCss, type ResolvedTheme } from './theme.js';
import { sanitizeInlineCss } from './inlineCss.js';

export interface EmbedHtmlOptions {
  title: string;
  baseCss: string;              // 模板自带 CSS
  userCss?: string;             // 已由 sanitizeInlineCss 过的 CSS；若传原始值会再跑一次
  bodyHtml: string;             // <body> 内容
  theme: ResolvedTheme;
  /** 额外 CSP `img-src` 项，例如 "'self' /api/avatar" */
  extraImgSrc?: string;
  /** 缓存秒数，默认 300 */
  cacheSeconds?: number;
  /** HTTP 状态码；默认 200。用于把 embed wrapper 复用给 404/410 等错误页。 */
  statusCode?: number;
}

function escapeHtml(str: string): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function sendEmbedHtml(res: Response, opts: EmbedHtmlOptions): void {
  const cleanUser = opts.userCss ? sanitizeInlineCss(opts.userCss) : '';
  const themeVars = buildThemeCss(opts.theme);
  const cacheSeconds = opts.cacheSeconds ?? 300;

  const imgSrc = opts.extraImgSrc || "data: https:";

  // frame-ancestors '*' 让任何站点都能 iframe；这是嵌入组件的必需品。
  // 关闭 script-src，所有行为用纯 CSS 实现。
  const csp = [
    "default-src 'none'",
    "base-uri 'none'",
    "style-src 'unsafe-inline'",
    `img-src ${imgSrc}`,
    "font-src data:",
    "connect-src 'none'",
    "frame-ancestors *"
  ].join('; ');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', `public, max-age=${cacheSeconds}`);
  res.setHeader('Content-Security-Policy', csp);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // 不设 X-Frame-Options: 留白即允许被任意站点 iframe
  res.removeHeader('X-Frame-Options');

  const html = `<!DOCTYPE html>
<html lang="zh-CN" data-theme="${opts.theme.theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>${escapeHtml(opts.title)}</title>
<style>${themeVars}</style>
<style>${opts.baseCss}</style>
${cleanUser ? `<style data-origin="user">${cleanUser}</style>` : ''}
</head>
<body class="e-body">${opts.bodyHtml}</body>
</html>`;

  const status = Number.isInteger(opts.statusCode) ? opts.statusCode! : 200;
  res.status(status).send(html);
}

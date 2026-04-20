import { estimateTextWidth } from './textMetrics.js';

export type BadgeStyle = 'flat' | 'plastic' | 'mono';

export interface BadgeOptions {
  label: string;
  value: string;
  color?: string;             // 右侧底色 (hex without #, or full CSS color)
  labelColor?: string;        // 左侧底色
  style?: BadgeStyle;
  /** 若 true，则使用 currentColor，供父级主题着色 */
  themeMono?: boolean;
  /** title 属性，会渲染成 <title> 供屏幕阅读器 / 悬停提示 */
  title?: string;
}

const DEFAULT_LABEL_BG = '#555';
const DEFAULT_VALUE_BG = '#4c1';

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function normalizeColor(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback;
  const trimmed = String(raw).trim();
  if (!trimmed) return fallback;
  // 仅接受 currentColor / 3-8 位 hex / 6-10 位带 # 的 hex / CSS 命名色白名单
  if (/^currentColor$/i.test(trimmed)) return 'currentColor';
  if (/^#?[0-9a-fA-F]{3,8}$/.test(trimmed)) {
    return trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
  }
  // 允许一些常见的主题关键字
  if (/^(transparent|black|white|gray|grey|red|green|blue|yellow|orange)$/i.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  return fallback;
}

/**
 * 生成一个 shields.io 风格的 SVG 徽章。
 *
 * 输出使用内联 SVG，字体 Verdana，宽度通过 estimateTextWidth 近似。
 * 文本使用 transform="scale(.1)" + font-size=110 的标准技巧规避 Verdana 子像素漂移。
 */
export function renderSvgBadge(opts: BadgeOptions): string {
  const style: BadgeStyle = opts.style || 'flat';
  const themeMono = Boolean(opts.themeMono);

  const label = String(opts.label ?? '').trim();
  const value = String(opts.value ?? '').trim();

  const labelBg = themeMono
    ? 'rgba(127,127,127,0.35)'
    : normalizeColor(opts.labelColor, DEFAULT_LABEL_BG);
  const valueBg = themeMono
    ? 'currentColor'
    : normalizeColor(opts.color, DEFAULT_VALUE_BG);
  const textFill = themeMono ? 'currentColor' : '#fff';
  const labelTextFill = themeMono ? 'currentColor' : '#fff';

  const labelTextWidth = estimateTextWidth(label);
  const valueTextWidth = estimateTextWidth(value);
  const padding = 6;
  const labelWidth = label ? labelTextWidth + padding * 2 : 0;
  const valueWidth = valueTextWidth + padding * 2;
  const totalWidth = labelWidth + valueWidth;
  const height = style === 'plastic' ? 18 : 20;
  const radius = style === 'plastic' ? 4 : 3;

  // 文本基线：Verdana 在 110pt 时上移到 140 看起来居中，并再加一条阴影文字实现轻微深度
  const labelCenterX = (labelWidth / 2) * 10;
  const valueCenterX = (labelWidth + valueWidth / 2) * 10;
  const textY = style === 'plastic' ? 130 : 140;
  const shadowY = textY + 10;

  const title = opts.title ? `<title>${escapeXml(opts.title)}</title>` : '';

  // 只有左侧标签非空时才渲染左侧块
  const labelRect = label
    ? `<rect width="${labelWidth}" height="${height}" fill="${labelBg}"/>`
    : '';
  const labelText = label
    ? `<text aria-hidden="true" x="${labelCenterX}" y="${shadowY}" transform="scale(.1)" fill="#010101" fill-opacity=".3">${escapeXml(label)}</text>
       <text x="${labelCenterX}" y="${textY}" transform="scale(.1)" fill="${labelTextFill}">${escapeXml(label)}</text>`
    : '';

  const gradient = style === 'flat' || themeMono
    ? ''
    : `<linearGradient id="g" x2="0" y2="100%">
         <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
         <stop offset="1" stop-opacity=".1"/>
       </linearGradient>
       <rect width="${totalWidth}" height="${height}" fill="url(#g)"/>`;

  const ariaLabel = label ? `${label}: ${value}` : value;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${height}" role="img" aria-label="${escapeXml(ariaLabel)}">
  ${title}
  <clipPath id="r"><rect width="${totalWidth}" height="${height}" rx="${radius}" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    ${labelRect}
    <rect x="${labelWidth}" width="${valueWidth}" height="${height}" fill="${valueBg}"/>
    ${gradient}
  </g>
  <g fill="${textFill}" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="110">
    ${labelText}
    <text aria-hidden="true" x="${valueCenterX}" y="${shadowY}" transform="scale(.1)" fill="#010101" fill-opacity=".3">${escapeXml(value)}</text>
    <text x="${valueCenterX}" y="${textY}" transform="scale(.1)">${escapeXml(value)}</text>
  </g>
</svg>`;
}

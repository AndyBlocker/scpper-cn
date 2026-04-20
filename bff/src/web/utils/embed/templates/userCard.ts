import type { UserBasic, UserCardStats } from '../userData.js';

export interface UserCardRenderOptions {
  breakdown: 'list' | 'radar';
  hideActivity: boolean;
  showCategories: string[];          // 要展示的 category key 列表；空数组=全部有数据的
}

function esc(str: string | null | undefined): string {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatInt(n: number): string {
  return Number.isFinite(n) ? Math.round(n).toLocaleString('zh-CN') : '—';
}

function formatFloat(n: number, digits = 1): string {
  return Number.isFinite(n) ? n.toFixed(digits) : '—';
}

function formatDate(d: Date | null): string {
  if (!d) return '—';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/**
 * 6 边雷达图。用用户自身各分类评分中的最大值作为满格，避免无作品的用户看到空图。
 * 每个顶点上再绘一个小点，突出非零分类。
 */
function renderRadar(categories: UserCardStats['categories']): string {
  const size = 220;
  const cx = size / 2;
  const cy = size / 2;
  const radius = 78;
  const n = categories.length;
  if (n < 3) return '';

  const maxRating = Math.max(...categories.map(c => c.rating), 1);
  const angles = categories.map((_, i) => (-Math.PI / 2) + (i * 2 * Math.PI) / n);

  const axisPoints = angles.map(a => {
    const x = cx + radius * Math.cos(a);
    const y = cy + radius * Math.sin(a);
    return { x, y };
  });

  const rings = [0.25, 0.5, 0.75, 1].map(frac => {
    const points = angles.map(a => {
      const x = cx + radius * frac * Math.cos(a);
      const y = cy + radius * frac * Math.sin(a);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    return `<polygon points="${points}" fill="none" stroke="var(--e-border)" stroke-width="1"/>`;
  }).join('');

  const axisLines = axisPoints.map(({ x, y }) =>
    `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="var(--e-border)" stroke-width="1"/>`
  ).join('');

  const dataPoints = categories.map((c, i) => {
    const r = (Math.max(0, c.rating) / maxRating) * radius;
    const a = angles[i];
    return {
      x: cx + r * Math.cos(a),
      y: cy + r * Math.sin(a),
      hasData: c.rating > 0
    };
  });

  const dataPolygon = dataPoints.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

  const markers = dataPoints.map((p, i) =>
    p.hasData
      ? `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" fill="var(--e-accent)"/>`
      : ''
  ).join('');

  const labels = categories.map((c, i) => {
    const a = angles[i];
    const lx = cx + (radius + 16) * Math.cos(a);
    const ly = cy + (radius + 16) * Math.sin(a);
    const anchor = Math.abs(Math.cos(a)) < 0.25 ? 'middle' : (Math.cos(a) > 0 ? 'start' : 'end');
    const dy = Math.sin(a) > 0.5 ? 10 : (Math.sin(a) < -0.5 ? -2 : 4);
    return `<text x="${lx.toFixed(1)}" y="${(ly + dy).toFixed(1)}" text-anchor="${anchor}" class="radar-label">${esc(c.label)}</text>`;
  }).join('');

  return `<svg viewBox="0 0 ${size} ${size}" class="radar-svg" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">
    <g class="radar-grid">${rings}${axisLines}</g>
    <polygon class="radar-data" points="${dataPolygon}" />
    ${markers}
    ${labels}
  </svg>`;
}

function renderCategoryList(categories: UserCardStats['categories'], keep: Set<string>): string {
  const visible = categories.filter(c => keep.size === 0 ? c.pageCount > 0 || c.rating > 0 : keep.has(c.key));
  if (visible.length === 0) {
    return `<div class="e-empty">暂无分类数据</div>`;
  }
  return `<ul class="cat-list">${visible.map(c => `
    <li class="cat-row">
      <span class="cat-label">${esc(c.label)}</span>
      <span class="cat-rank">${c.rank != null ? `#${formatInt(c.rank)}` : '—'}</span>
      <span class="cat-rating">${formatInt(c.rating)} pts</span>
      <span class="cat-count">${formatInt(c.pageCount)} 作</span>
    </li>`).join('')}</ul>`;
}

export const USER_CARD_BASE_CSS = `
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: transparent; }
  body { font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", Roboto, sans-serif; color: var(--e-text); font-size: 13px; line-height: 1.45; -webkit-font-smoothing: antialiased; }
  .e-card { background: var(--e-bg); border: 1px solid var(--e-border); border-radius: 14px; padding: 18px 20px; box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 2px 8px rgba(0,0,0,0.02); display: flex; flex-direction: column; gap: 16px; }
  .e-header { display: flex; align-items: center; gap: 14px; position: relative; }
  .e-avatar { width: 56px; height: 56px; border-radius: 50%; overflow: hidden; background: var(--e-surface); flex-shrink: 0; ring: 1px solid var(--e-border); position: relative; }
  .e-avatar img { display: block; width: 100%; height: 100%; object-fit: cover; }
  .e-name-block { min-width: 0; flex: 1; }
  .e-name { font-size: 16px; font-weight: 600; color: var(--e-accent); display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .e-subtitle { font-size: 11px; color: var(--e-text-subtle); margin-top: 2px; display: flex; gap: 6px; flex-wrap: wrap; }
  .e-subtitle span:not(:last-child)::after { content: '·'; margin-left: 6px; color: var(--e-text-subtle); }
  .e-rank { position: absolute; top: 0; right: 0; color: var(--e-accent); font-weight: 700; font-size: 15px; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
  .stat-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; }
  .stat-tile { background: var(--e-surface); border: 1px solid var(--e-border); border-radius: 8px; padding: 8px 10px; text-align: center; }
  .stat-tile .lbl { font-size: 10px; color: var(--e-text-muted); margin-bottom: 2px; letter-spacing: 0.02em; }
  .stat-tile .val { font-size: 14px; font-weight: 600; color: var(--e-text); font-variant-numeric: tabular-nums; }
  .section-title { font-size: 11px; color: var(--e-text-muted); font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; margin-bottom: 6px; }
  .cat-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 4px; }
  .cat-row { display: grid; grid-template-columns: 4em 3em 1fr auto; gap: 10px; align-items: baseline; padding: 6px 10px; background: var(--e-surface); border: 1px solid var(--e-border); border-radius: 6px; font-size: 12px; }
  .cat-label { color: var(--e-text); font-weight: 500; }
  .cat-rank { color: var(--e-accent); font-weight: 600; font-variant-numeric: tabular-nums; }
  .cat-rating { color: var(--e-text-muted); font-variant-numeric: tabular-nums; }
  .cat-count { color: var(--e-text-subtle); font-variant-numeric: tabular-nums; font-size: 11px; }
  .radar-wrap { display: flex; justify-content: center; align-items: center; height: 230px; }
  .radar-svg { max-width: 280px; }
  .radar-grid { stroke: var(--e-border); fill: none; }
  .radar-data { fill: var(--e-accent-soft); stroke: var(--e-accent); stroke-width: 1.5; }
  .radar-label { fill: var(--e-text-muted); font-size: 10px; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; }
  .e-empty { color: var(--e-text-subtle); font-size: 11px; text-align: center; padding: 12px 0; }
`;

export function renderUserCardBody(
  user: UserBasic,
  stats: UserCardStats,
  opts: UserCardRenderOptions
): string {
  const wikidotId = user.wikidotId;
  const displayName = user.displayName || `User ${wikidotId}`;

  const activityLine = opts.hideActivity
    ? ''
    : `<span>首次 ${esc(formatDate(user.firstActivityAt))}</span><span>最近 ${esc(formatDate(user.lastActivityAt))}</span>`;

  const subtitleParts = [`<span>ID ${wikidotId}</span>`];
  if (activityLine) subtitleParts.push(activityLine);

  const meanRating = Number.isFinite(stats.meanRating) && stats.meanRating > 0
    ? stats.meanRating
    : (stats.pageCount > 0 ? stats.totalRating / stats.pageCount : 0);

  const rank = stats.rank != null
    ? `<div class="e-rank">#${formatInt(stats.rank)}</div>`
    : '';

  const keep = new Set(opts.showCategories.filter(Boolean));
  const breakdownHtml = opts.breakdown === 'radar'
    ? `<div class="radar-wrap">${renderRadar(stats.categories.filter(c => keep.size === 0 ? true : keep.has(c.key)))}</div>`
    : renderCategoryList(stats.categories, keep);

  return `<div class="e-card">
    <header class="e-header">
      <div class="e-avatar">
        <img src="/api/avatar/${wikidotId}" alt="${esc(displayName)}" width="56" height="56"
             onerror="this.style.visibility='hidden'"/>
      </div>
      <div class="e-name-block">
        <span class="e-name">${esc(displayName)}</span>
        <div class="e-subtitle">${subtitleParts.join('')}</div>
      </div>
      ${rank}
    </header>

    <section class="stat-grid">
      <div class="stat-tile"><div class="lbl">总评分</div><div class="val">${formatInt(stats.totalRating)}</div></div>
      <div class="stat-tile"><div class="lbl">平均分</div><div class="val">${formatFloat(meanRating, 1)}</div></div>
      <div class="stat-tile"><div class="lbl">作品</div><div class="val">${formatInt(stats.pageCount)}</div></div>
      <div class="stat-tile"><div class="lbl">支持</div><div class="val">${formatInt(stats.votesUp)}</div></div>
      <div class="stat-tile"><div class="lbl">反对</div><div class="val">${formatInt(stats.votesDown)}</div></div>
    </section>

    <section>
      <div class="section-title">分类表现</div>
      ${breakdownHtml}
    </section>
  </div>`;
}

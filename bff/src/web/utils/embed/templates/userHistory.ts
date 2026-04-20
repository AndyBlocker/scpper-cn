import type { UserBasic, VotingSeries } from '../userData.js';

export interface UserHistoryRenderOptions {
  range: '90d' | '1y' | 'all';
  showTrend: boolean;
  showHeatmap: boolean;
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

/**
 * 从 VotingSeries 生成累计评分序列（upvotes[i] - downvotes[i]）。
 */
function buildCumulativeRating(series: VotingSeries): Array<{ date: string; rating: number }> {
  const out: Array<{ date: string; rating: number }> = [];
  const n = series.dates.length;
  for (let i = 0; i < n; i += 1) {
    const up = series.upvotes[i] ?? 0;
    const down = series.downvotes[i] ?? 0;
    out.push({ date: series.dates[i], rating: up - down });
  }
  return out;
}

function trimToRange(points: Array<{ date: string; rating: number }>, range: UserHistoryRenderOptions['range']): Array<{ date: string; rating: number }> {
  if (range === 'all' || points.length === 0) return points;
  const days = range === '90d' ? 90 : 365;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  return points.filter(p => p.date >= cutoffStr);
}

/**
 * 一条带 y 轴坐标的评分曲线。大致视觉：左下 padding 留 Y 轴，底部留 X 轴文本。
 */
function renderRatingChart(points: Array<{ date: string; rating: number }>): string {
  const width = 560;
  const height = 220;
  const padL = 42;
  const padR = 12;
  const padT = 12;
  const padB = 24;

  if (points.length < 2) {
    return `<div class="e-empty chart-empty">数据不足以绘制曲线</div>`;
  }

  const ratings = points.map(p => p.rating);
  const minY = Math.min(...ratings, 0);
  const maxY = Math.max(...ratings, minY + 1);
  const rangeY = maxY - minY;

  const usableW = width - padL - padR;
  const usableH = height - padT - padB;
  const n = points.length;

  const x = (i: number) => padL + (usableW * i) / (n - 1);
  const y = (v: number) => padT + usableH - ((v - minY) / rangeY) * usableH;

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(p.rating).toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L${x(n - 1).toFixed(1)} ${(padT + usableH).toFixed(1)} L${x(0).toFixed(1)} ${(padT + usableH).toFixed(1)} Z`;

  // Y 轴刻度：选 4 档
  const yTicks = [0, 0.33, 0.66, 1].map(frac => {
    const val = minY + frac * rangeY;
    return {
      y: y(val),
      label: formatInt(val)
    };
  });

  // X 轴三个时间标签：首 / 中 / 末
  const xTicks = [0, Math.floor((n - 1) / 2), n - 1].map(i => ({
    x: x(i),
    label: points[i].date
  }));

  return `<svg class="chart-svg" viewBox="0 0 ${width} ${height}" width="100%" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">
    <g class="chart-grid">
      ${yTicks.map(t => `<line x1="${padL}" x2="${width - padR}" y1="${t.y.toFixed(1)}" y2="${t.y.toFixed(1)}" />`).join('')}
    </g>
    <path class="chart-area" d="${areaPath}" />
    <path class="chart-line" d="${linePath}" />
    <g class="chart-axis-y">
      ${yTicks.map(t => `<text x="${padL - 6}" y="${(t.y + 3).toFixed(1)}" text-anchor="end">${esc(t.label)}</text>`).join('')}
    </g>
    <g class="chart-axis-x">
      ${xTicks.map(t => `<text x="${t.x.toFixed(1)}" y="${height - 6}" text-anchor="middle">${esc(t.label)}</text>`).join('')}
    </g>
  </svg>`;
}

/**
 * GitHub 风格的活动热力图：12 个月 / 53 周 / 7 天。
 * dayMap 的 key 是 YYYY-MM-DD。
 */
function renderHeatmap(dayMap: Map<string, number>): string {
  const cellSize = 11;
  const gap = 2;
  const today = new Date();
  // 以今天为最后一格的日子，算出 52×7 网格左上角需要对齐的起点（让最后一列包含今天）
  const weeks = 52;
  const totalDays = weeks * 7;

  // 起点：totalDays-1 天前，再往前推到那天所在的"周一"
  const start = new Date(today);
  start.setDate(today.getDate() - (totalDays - 1));
  // 把 start 对齐到周一（getDay: 0=Sun,1=Mon...）
  const dow = start.getDay();
  const daysToMonday = (dow + 6) % 7;
  start.setDate(start.getDate() - daysToMonday);

  // 收集非零值以便分档
  const allValues = Array.from(dayMap.values()).filter(v => v > 0);
  const sorted = allValues.slice().sort((a, b) => a - b);
  const q = (frac: number) => sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * frac))];
  const thresholds = [q(0.25), q(0.5), q(0.75), q(1)];

  function levelFor(v: number): number {
    if (v <= 0) return 0;
    for (let i = 0; i < thresholds.length; i += 1) {
      if (v <= thresholds[i]) return i + 1;
    }
    return 4;
  }

  // 构造格子
  const cellsPerWeek = 7;
  const totalWeeks = Math.ceil((totalDays + daysToMonday) / 7);
  const cells: string[] = [];
  const monthLabels: string[] = [];
  let lastMonth = -1;

  for (let w = 0; w < totalWeeks; w += 1) {
    for (let d = 0; d < cellsPerWeek; d += 1) {
      const cur = new Date(start);
      cur.setDate(start.getDate() + w * 7 + d);
      if (cur > today) continue;
      const y = d * (cellSize + gap);
      const x = w * (cellSize + gap);
      const iso = cur.toISOString().slice(0, 10);
      const v = dayMap.get(iso) ?? 0;
      const lvl = levelFor(v);
      const title = v > 0 ? `${iso}: ${v}` : iso;
      cells.push(`<rect x="${x}" y="${y}" width="${cellSize}" height="${cellSize}" rx="2" ry="2" class="hm-cell lvl-${lvl}"><title>${esc(title)}</title></rect>`);

      if (d === 0) {
        const month = cur.getMonth();
        if (month !== lastMonth) {
          monthLabels.push(`<text x="${x}" y="-4" class="hm-month">${cur.getMonth() + 1}月</text>`);
          lastMonth = month;
        }
      }
    }
  }

  const svgWidth = totalWeeks * (cellSize + gap);
  const svgHeight = 7 * (cellSize + gap) + 14;

  return `<div class="hm-wrap">
    <svg class="hm-svg" viewBox="0 -14 ${svgWidth} ${svgHeight}" width="100%" preserveAspectRatio="xMinYMid meet" xmlns="http://www.w3.org/2000/svg">
      <g class="hm-months">${monthLabels.join('')}</g>
      <g class="hm-cells">${cells.join('')}</g>
    </svg>
    <div class="hm-legend">
      <span>活跃度</span>
      <span class="hm-chip lvl-0"></span>
      <span class="hm-chip lvl-1"></span>
      <span class="hm-chip lvl-2"></span>
      <span class="hm-chip lvl-3"></span>
      <span class="hm-chip lvl-4"></span>
    </div>
  </div>`;
}

export const USER_HISTORY_BASE_CSS = `
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: transparent; }
  body { font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", Roboto, sans-serif; color: var(--e-text); font-size: 13px; line-height: 1.45; -webkit-font-smoothing: antialiased; }
  .e-card { background: var(--e-bg); border: 1px solid var(--e-border); border-radius: 14px; padding: 18px 20px; box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 2px 8px rgba(0,0,0,0.02); display: flex; flex-direction: column; gap: 18px; }
  .e-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .e-title { font-size: 15px; font-weight: 600; color: var(--e-text); }
  .e-name-inline { color: var(--e-accent); font-weight: 600; }
  .e-sub { color: var(--e-text-subtle); font-size: 11px; }
  .section-title { font-size: 11px; color: var(--e-text-muted); font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; margin-bottom: 8px; }
  .chart-wrap { background: var(--e-surface); border: 1px solid var(--e-border); border-radius: 8px; padding: 10px; }
  .chart-svg { display: block; width: 100%; height: auto; }
  .chart-grid line { stroke: var(--e-border); stroke-dasharray: 2 3; }
  .chart-area { fill: var(--e-accent-soft); }
  .chart-line { fill: none; stroke: var(--e-accent); stroke-width: 1.8; stroke-linejoin: round; }
  .chart-axis-y text, .chart-axis-x text { fill: var(--e-text-muted); font-size: 10px; font-family: inherit; font-variant-numeric: tabular-nums; }
  .chart-empty { color: var(--e-text-subtle); text-align: center; padding: 24px 0; }
  .hm-wrap { background: var(--e-surface); border: 1px solid var(--e-border); border-radius: 8px; padding: 16px 12px 12px; }
  .hm-svg { display: block; }
  .hm-months text { fill: var(--e-text-subtle); font-size: 9px; font-family: inherit; }
  .hm-cell { fill: var(--e-border); }
  .hm-cell.lvl-0 { fill: var(--e-border); fill-opacity: 0.5; }
  .hm-cell.lvl-1 { fill: color-mix(in srgb, var(--e-accent) 28%, var(--e-border)); }
  .hm-cell.lvl-2 { fill: color-mix(in srgb, var(--e-accent) 52%, var(--e-border)); }
  .hm-cell.lvl-3 { fill: color-mix(in srgb, var(--e-accent) 76%, var(--e-border)); }
  .hm-cell.lvl-4 { fill: var(--e-accent); }
  .hm-legend { display: flex; align-items: center; gap: 6px; color: var(--e-text-muted); font-size: 10px; margin-top: 8px; justify-content: flex-end; }
  .hm-chip { display: inline-block; width: 10px; height: 10px; border-radius: 2px; }
  .hm-chip.lvl-0 { background: var(--e-border); opacity: 0.5; }
  .hm-chip.lvl-1 { background: color-mix(in srgb, var(--e-accent) 28%, var(--e-border)); }
  .hm-chip.lvl-2 { background: color-mix(in srgb, var(--e-accent) 52%, var(--e-border)); }
  .hm-chip.lvl-3 { background: color-mix(in srgb, var(--e-accent) 76%, var(--e-border)); }
  .hm-chip.lvl-4 { background: var(--e-accent); }
  .e-empty { color: var(--e-text-subtle); font-size: 11px; text-align: center; padding: 12px 0; }
`;

export function renderUserHistoryBody(
  user: UserBasic,
  series: VotingSeries | null,
  heatmapDaily: Array<{ date: string; votes: number; pages: number }>,
  opts: UserHistoryRenderOptions
): string {
  const displayName = user.displayName || `User ${user.wikidotId}`;

  const chartHtml = opts.showTrend
    ? (series
      ? `<div class="chart-wrap">${renderRatingChart(trimToRange(buildCumulativeRating(series), opts.range))}</div>`
      : `<div class="chart-wrap"><div class="e-empty chart-empty">暂无评分历史缓存</div></div>`)
    : '';

  const dayMap = new Map<string, number>();
  for (const row of heatmapDaily) {
    dayMap.set(row.date, row.votes + row.pages * 3);
  }

  const heatmapHtml = opts.showHeatmap
    ? renderHeatmap(dayMap)
    : '';

  return `<div class="e-card">
    <header class="e-header">
      <div class="e-title">
        <span class="e-name-inline">${esc(displayName)}</span>
        <span class="e-sub">ID ${user.wikidotId}</span>
      </div>
    </header>

    ${opts.showTrend ? `<section>
      <div class="section-title">评分曲线 · ${esc(opts.range === '90d' ? '近 90 天' : opts.range === '1y' ? '近 1 年' : '全部历史')}</div>
      ${chartHtml}
    </section>` : ''}

    ${opts.showHeatmap ? `<section>
      <div class="section-title">近一年活动</div>
      ${heatmapHtml}
    </section>` : ''}
  </div>`;
}

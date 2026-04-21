import type { UserBasic, UserCardStats, CategoryBenchmarksPayload, CategoryBenchmark } from '../userData.js';

export interface UserCardRenderOptions {
  breakdown: 'list' | 'radar';
  hideActivity: boolean;
  showCategories: string[];
  /** 全站分类基准（由 backend UserCategoryBenchmarksJob 预计算）。无则降级到自身最高值归一化。 */
  benchmarks: CategoryBenchmarksPayload | null;
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

function avatarLetter(displayName: string, wikidotId: number): string {
  const trimmed = (displayName ?? '').trim();
  if (trimmed.length > 0) {
    return Array.from(trimmed)[0].toUpperCase();
  }
  const s = String(wikidotId);
  return s[s.length - 1] ?? '·';
}

function formatDate(d: Date | string | number | null | undefined): string {
  if (d == null || d === '') return '—';
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return '—';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

// ─────────────────────────────────────────────────────────────────
// 归一化：与前端 UserCategoryRadarChart.vue 一致的三档算法（v3 分段 asinh /
// v2 asinh / v1 线性），始终把 rating 映射到 0-100 的"全站百分位"分数。
// 语义锚点：p50 = 50 分（站点中位）、p95 = 90 分、p99 = 100 分。
// 把"雷达顶到外圈"=  全站 p99 水平；"圆心"=  低于 p05 或未参与。
// ─────────────────────────────────────────────────────────────────

function piecewiseAsinhMap(v: number, b: CategoryBenchmark): number {
  const clamp = (x: number) => Math.max(0, Math.min(100, x));
  const t = Math.max(1e-6, Number(b.tau) || 1);
  const g = (x: number) => Math.asinh(Number(x || 0) / t);
  const y = g(v);
  const y05 = g(b.p05Rating || 0);
  const y50 = g(b.p50Rating || 0);
  const y95 = g(b.p95Rating || 1);
  const y99 = g(b.p99Rating || (b.p95Rating || 1) + 1e-6);
  const safe = (a: number, c: number) => Math.abs(c - a) < 1e-6 ? 1e-6 : (c - a);
  if (v <= b.p50Rating) return clamp(50 * (y - y05) / safe(y05, y50));
  if (v <= b.p95Rating) return clamp(50 + 40 * (y - y50) / safe(y50, y95));
  const beta = 0.7;
  const tail = Math.pow((y - y95) / safe(y95, y99), beta);
  return clamp(90 + 10 * tail);
}

function asinhMap(v: number, p50: number, p95: number, tau: number): number {
  const t = Math.max(1e-6, Number(tau) || 0);
  const g = (x: number) => Math.asinh(Number(x || 0) / t);
  const denom = g(p95) - g(p50);
  if (!Number.isFinite(denom) || Math.abs(denom) < 1e-6) return 50;
  return Math.min(100, Math.max(0, 50 + 50 * (g(v) - g(p50)) / denom));
}

function linearMap(v: number, p50: number, p95: number): number {
  const denom = p95 - p50;
  if (!Number.isFinite(denom) || Math.abs(denom) < 1e-6) return 50;
  return Math.min(100, Math.max(0, 50 + 50 * (v - p50) / denom));
}

function scoreFromBenchmark(
  rating: number,
  b: CategoryBenchmark | undefined,
  method: CategoryBenchmarksPayload['method']
): number {
  if (!b) return 0;
  if (method === 'asinh_piecewise_p50_p95_p99_v3') return piecewiseAsinhMap(rating, b);
  if (method === 'asinh_p50_p95_v2') return asinhMap(rating, b.p50Rating || 0, b.p95Rating || 1, b.tau || 1);
  return linearMap(rating, b.p50Rating || 0, b.p95Rating || 1);
}

/**
 * 雷达图。归一化口径：
 *   - 若提供 benchmarks → 用 piecewiseAsinh 把每分类 rating 映射到 0-100 分（全站百分位），
 *     半径 = score/100 × radius。跨用户可比，"顶到外圈"恒等于全站 p99 水平。
 *   - 若无 benchmarks → 降级到自身最高值 sqrt 归一化（仅用于开发环境或 benchmarks job 未运行时）。
 *
 * 零值/未参与（rating==0 或 rank==null）：不算"做得差"。轴线画虚线弱化，
 * 数据 polygon 跳过此顶点直接连到相邻有效点。
 */
function renderRadar(
  categories: UserCardStats['categories'],
  benchmarks: CategoryBenchmarksPayload | null
): string {
  const size = 220;
  const cx = size / 2;
  const cy = size / 2;
  const radius = 66;
  const n = categories.length;
  if (n < 3) return '';

  const angles = categories.map((_, i) => (-Math.PI / 2) + (i * 2 * Math.PI) / n);
  const isActive = (c: UserCardStats['categories'][number]) => c.rating > 0 && c.rank != null;

  const useBenchmark = !!benchmarks;
  const method = benchmarks?.method ?? 'asinh_piecewise_p50_p95_p99_v3';

  // 计算每顶点的归一化 score（0-1）
  const normalized = categories.map(c => {
    if (!isActive(c)) return 0;
    if (useBenchmark) {
      const b = benchmarks!.benchmarks[c.key];
      return scoreFromBenchmark(c.rating, b, method) / 100;
    }
    // fallback：自身最高值 sqrt 归一化
    const selfMax = Math.max(...categories.map(x => x.rating), 1);
    return Math.sqrt(c.rating) / Math.sqrt(selfMax);
  });

  // 网格圈
  const rings = [0.25, 0.5, 0.75, 1].map(frac => {
    const pts = angles.map(a => {
      const x = cx + radius * frac * Math.cos(a);
      const y = cy + radius * frac * Math.sin(a);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    const klass = frac === 0.5 && useBenchmark ? 'radar-ring ref-p50' : 'radar-ring';
    return `<polygon class="${klass}" points="${pts}" />`;
  }).join('');

  // 轴线
  const axisLines = angles.map((a, i) => {
    const x = cx + radius * Math.cos(a);
    const y = cy + radius * Math.sin(a);
    const klass = isActive(categories[i]) ? 'radar-axis' : 'radar-axis inactive';
    return `<line class="${klass}" x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}"/>`;
  }).join('');

  // 有效顶点集合（跳过未参与）
  const activePoints = categories
    .map((c, i) => ({ c, i, angle: angles[i], r: normalized[i] * radius }))
    .filter(({ c }) => isActive(c))
    .map(({ angle, r }) => ({ x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) }));

  let dataShape = '';
  if (activePoints.length >= 3) {
    const pts = activePoints.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    dataShape = `<polygon class="radar-data" points="${pts}" />`;
  } else if (activePoints.length === 2) {
    const [a, b] = activePoints;
    dataShape = `<line class="radar-data-edge" x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" />`;
  } else if (activePoints.length === 1) {
    const a = activePoints[0];
    dataShape = `<circle class="radar-data-dot" cx="${a.x.toFixed(1)}" cy="${a.y.toFixed(1)}" r="3" />`;
  }

  const markers = categories.map((c, i) => {
    if (!isActive(c)) return '';
    const r = normalized[i] * radius;
    const x = cx + r * Math.cos(angles[i]);
    const y = cy + r * Math.sin(angles[i]);
    return `<circle class="radar-dot" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.5"/>`;
  }).join('');

  const labels = categories.map((c, i) => {
    const a = angles[i];
    const lx = cx + (radius + 13) * Math.cos(a);
    const ly = cy + (radius + 13) * Math.sin(a);
    const anchor = Math.abs(Math.cos(a)) < 0.25 ? 'middle' : (Math.cos(a) > 0 ? 'start' : 'end');
    const dy = Math.sin(a) > 0.5 ? 9 : (Math.sin(a) < -0.5 ? -2 : 4);
    const inactive = !isActive(c);
    const labelClass = inactive ? 'radar-label inactive' : 'radar-label';
    return `<text class="${labelClass}" x="${lx.toFixed(1)}" y="${(ly + dy).toFixed(1)}" text-anchor="${anchor}">${esc(c.label)}</text>`;
  }).join('');

  // p50/p99 参考标注，只在用 benchmark 时显示
  const refNotes = useBenchmark ? `
    <text class="radar-ref" x="${cx}" y="${(cy - radius * 0.5 - 3).toFixed(1)}" text-anchor="middle">p50</text>
    <text class="radar-ref radar-ref-outer" x="${cx}" y="${(cy - radius - 5).toFixed(1)}" text-anchor="middle">p99</text>
  ` : '';

  return `<svg viewBox="0 0 ${size} ${size}" class="radar-svg" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">
    <g class="radar-grid">${rings}${axisLines}</g>
    ${dataShape}
    ${markers}
    ${labels}
    ${refNotes}
  </svg>`;
}

function renderCategoryList(categories: UserCardStats['categories']): string {
  if (categories.length === 0) {
    return `<div class="e-empty">暂无分类数据</div>`;
  }
  return `<ul class="cat-list">${categories.map(c => {
    const inactiveClass = (c.rating <= 0 || c.rank == null) ? ' is-inactive' : '';
    return `
    <li class="cat-row${inactiveClass}">
      <span class="cat-label">${esc(c.label)}</span>
      <span class="cat-rank">${c.rank != null ? `#${formatInt(c.rank)}` : '—'}</span>
      <span class="cat-meta">${formatInt(c.rating)} · ${formatInt(c.pageCount)} 作品</span>
    </li>`;
  }).join('')}</ul>`;
}

export const USER_CARD_BASE_CSS = `
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: transparent; }
  body { font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", Roboto, sans-serif; color: var(--e-fg); font-size: 13px; line-height: 1.45; -webkit-font-smoothing: antialiased; }

  .e-card { background: var(--e-bg); border: 1px solid var(--e-border); border-radius: 14px; padding: 18px 20px; box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 2px 8px rgba(0,0,0,0.02); display: flex; flex-direction: column; gap: 14px; }

  .breakdown-mode { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }

  /* Header —— capsule 搬到 rank 正下方、subtitle 右侧（header 右端纵向堆叠）。
     这样 body 里的两列（stat-grid / breakdown）都从 y=0 开始，总评分 tile 顶边和
     SCP 列表行顶边天然对齐。 */
  .e-header { display: flex; align-items: flex-start; gap: 14px; }
  .e-avatar { position: relative; width: 56px; height: 56px; border-radius: 50%; overflow: hidden; flex-shrink: 0; border: 1px solid var(--e-border); background: var(--e-accent-soft); display: flex; align-items: center; justify-content: center; }
  .e-avatar-letter { font-size: 22px; font-weight: 700; color: var(--e-accent); line-height: 1; user-select: none; }
  .e-avatar-image { position: absolute; inset: 0; background-position: center; background-size: cover; background-repeat: no-repeat; }
  .e-name-block { min-width: 0; flex: 1; padding-top: 2px; }
  .e-name { font-size: 16px; font-weight: 600; color: var(--e-accent); display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .e-subtitle { font-size: 11px; color: var(--e-fg-subtle); margin-top: 3px; display: flex; gap: 12px; flex-wrap: wrap; }

  .e-header-side { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; flex-shrink: 0; min-height: 56px; justify-content: space-between; }
  .e-rank { color: var(--e-accent); font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1; display: inline-flex; align-items: baseline; gap: 3px; }
  .e-rank-prefix { font-size: 10px; color: var(--e-fg-muted); font-weight: 500; letter-spacing: 0.02em; }
  .e-rank-num { font-size: 15px; letter-spacing: -0.01em; }

  /* 两列主体：stretch 让两列等高；两列第一行 y=0 对齐（capsule 已搬走）。
     窄 iframe（wikidot [[iframe]] 常见宽度 400-560px）下回退单列纵排，恢复"宽大"视觉；
     阈值选 560 是因为 wikidot 默认正文列宽 ~620-760，iframe 通常被 wrap 到 550 以下。 */
  .uc-body { display: grid; grid-template-columns: minmax(0, 0.95fr) minmax(0, 1.15fr); gap: 16px; align-items: stretch; }
  @media (max-width: 560px) {
    .uc-body { grid-template-columns: minmax(0, 1fr); gap: 12px; }
    /* 单列下 stat-grid 横排 4 tile，每个 tile 仍有足够宽度展示数字 */
    .stat-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); grid-template-rows: auto; }
    /* 窄屏下 header 允许 capsule wrap 到下一行，不挤压 name-block */
    .e-header { flex-wrap: wrap; }
    .e-header-side { flex-direction: row; width: 100%; min-height: 0; justify-content: space-between; align-items: center; order: 2; gap: 12px; }
  }
  /* 极窄 iframe（< 380px）下进一步压缩：stat-grid 2×2 回到紧凑方阵，
     cat-row 去掉固定 rank 列宽让 label 吃掉空间 */
  @media (max-width: 380px) {
    .stat-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); grid-template-rows: auto; }
    .cat-row { grid-template-columns: 1fr auto auto; gap: 8px; padding: 6px 10px; }
    .cat-meta { font-size: 10.5px; }
  }

  /* stat-grid 4 tile 2×2 等大方阵：总评分 | 作品 / 投出 UpVote | 投出 DownVote。
     align-content: stretch + grid-template-rows: 1fr 1fr 让每行被拉伸到 stat-grid
     总高（总高 = breakdown 列高度 via e-body align-items: stretch）。 */
  .stat-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); grid-template-rows: 1fr 1fr; gap: 8px; align-content: stretch; }
  .stat-tile { background: var(--e-surface); border: 1px solid var(--e-border); border-radius: 8px; padding: 8px 10px; text-align: center; display: flex; flex-direction: column; justify-content: center; gap: 2px; min-height: 0; }
  .stat-tile .lbl { font-size: 10px; color: var(--e-fg-muted); letter-spacing: 0.04em; }
  .stat-tile .val { font-size: 15px; font-weight: 600; color: var(--e-fg); font-variant-numeric: tabular-nums; }

  /* Breakdown：capsule 搬到 header 后，这里只剩 stage */
  .breakdown { display: flex; flex-direction: column; min-width: 0; height: 100%; }
  .mode-tabs { display: inline-flex; background: var(--e-surface); border: 1px solid var(--e-border); border-radius: 999px; padding: 2px; gap: 2px; }
  .mode-tab { font-size: 10.5px; line-height: 1; padding: 4px 10px; border-radius: 999px; color: var(--e-fg-muted); cursor: pointer; user-select: none; letter-spacing: 0.02em; transition: color 120ms ease, background-color 120ms ease; }
  .mode-tab:hover { color: var(--e-fg); }
  .mode-tab.disabled { color: var(--e-fg-subtle); cursor: not-allowed; opacity: 0.6; }

  /* Stage：list 走正常流决定 stage 高度；radar absolute 覆盖在 stage 上，不参与 layout。
     这样 stage 高度 = list 自然高度，切换不抖动，radar SVG 被 stage 反向约束不会自撑成大方块。 */
  .breakdown-stage { position: relative; flex: 1; min-height: 0; }
  .panel-list { position: relative; visibility: hidden; }
  .panel-radar { position: absolute; inset: 0; visibility: hidden; }
  /* radio 在 .e-card 直接子，选择器穿过 .uc-body / .e-header 触达 panel 与 tab */
  #bk-mode-list:checked ~ .uc-body .panel-list { visibility: visible; }
  #bk-mode-radar:checked ~ .uc-body .panel-radar { visibility: visible; }
  #bk-mode-list:checked ~ .e-header .mode-tab[for="bk-mode-list"],
  #bk-mode-radar:checked ~ .e-header .mode-tab[for="bk-mode-radar"] {
    background: var(--e-bg); color: var(--e-accent); box-shadow: 0 1px 2px rgba(0,0,0,0.06);
  }

  /* 列表 */
  .cat-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 5px; }
  .cat-row { display: grid; grid-template-columns: 5em 3em 1fr; gap: 10px; align-items: baseline; padding: 6px 10px; background: var(--e-surface); border: 1px solid var(--e-border); border-radius: 6px; font-size: 12px; }
  .cat-row.is-inactive { opacity: 0.55; }
  .cat-label { color: var(--e-fg); font-weight: 500; }
  .cat-rank { color: var(--e-accent); font-weight: 600; font-variant-numeric: tabular-nums; text-align: right; }
  .cat-row.is-inactive .cat-rank { color: var(--e-fg-subtle); }
  .cat-meta { color: var(--e-fg-muted); font-variant-numeric: tabular-nums; text-align: right; font-size: 11px; }

  /* 雷达 —— SVG 随 stage 高度缩放，而不是按 viewBox 1:1 自撑；这样 stage 高度由
     list panel 的自然高决定，radar 跟随，切换不抖动、也不出现下部留白。 */
  .panel-radar { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; }
  .radar-svg { width: auto; height: 100%; max-width: 100%; max-height: 100%; overflow: visible; }
  .radar-ring { fill: none; stroke: var(--e-border); stroke-width: 1; }
  .radar-ring.ref-p50 { stroke-dasharray: 3 3; stroke: var(--e-border-strong); }
  .radar-axis { stroke: var(--e-border); stroke-width: 1; }
  .radar-axis.inactive { stroke-dasharray: 3 3; opacity: 0.55; }
  .radar-data { fill: var(--e-accent-soft); stroke: var(--e-accent); stroke-width: 1.5; }
  .radar-data-edge { stroke: var(--e-accent); stroke-width: 1.5; fill: none; }
  .radar-data-dot { fill: var(--e-accent); }
  .radar-dot { fill: var(--e-accent); }
  .radar-label { fill: var(--e-fg-muted); font-size: 9px; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; }
  .radar-label.inactive { fill: var(--e-fg-subtle); opacity: 0.55; }
  .radar-ref { fill: var(--e-fg-subtle); font-size: 7.5px; font-family: inherit; font-variant-numeric: tabular-nums; letter-spacing: 0.02em; }

  .e-empty { color: var(--e-fg-subtle); font-size: 11px; text-align: center; padding: 12px 0; }
`;

export function renderUserCardBody(
  user: UserBasic,
  stats: UserCardStats,
  opts: UserCardRenderOptions
): string {
  const wikidotId = user.wikidotId;
  const displayName = user.displayName || `User ${wikidotId}`;

  const activityParts = opts.hideActivity
    ? []
    : [`首次 ${formatDate(user.firstActivityAt)}`, `最近 ${formatDate(user.lastActivityAt)}`];

  const subtitleParts = [`ID ${wikidotId}`, ...activityParts];

  const rank = stats.rank != null
    ? `<div class="e-rank"><span class="e-rank-prefix">全站</span><span class="e-rank-num">#${formatInt(stats.rank)}</span></div>`
    : '';

  const keep = new Set(opts.showCategories.filter(Boolean));
  const sharedCategories = keep.size === 0
    ? stats.categories
    : stats.categories.filter(c => keep.has(c.key));

  const radarAvailable = sharedCategories.length >= 3;
  const initialMode: 'list' | 'radar' =
    opts.breakdown === 'radar' && radarAvailable ? 'radar' : 'list';

  const listHtml = renderCategoryList(sharedCategories);
  const radarHtml = radarAvailable ? renderRadar(sharedCategories, opts.benchmarks) : '';

  const letter = esc(avatarLetter(displayName, wikidotId));
  const avatarStyle = `background-image: url(/api/avatar/${wikidotId})`;

  const listChecked = initialMode === 'list' ? 'checked' : '';
  const radarChecked = initialMode === 'radar' ? 'checked' : '';

  const radarTab = radarAvailable
    ? `<label class="mode-tab" for="bk-mode-radar">雷达</label>`
    : `<span class="mode-tab disabled" title="分类不足，无法绘制雷达图">雷达</span>`;

  return `<div class="e-card">
    <input type="radio" name="bk-mode" id="bk-mode-list" class="breakdown-mode" ${listChecked}>
    <input type="radio" name="bk-mode" id="bk-mode-radar" class="breakdown-mode" ${radarChecked} ${radarAvailable ? '' : 'disabled'}>

    <header class="e-header">
      <div class="e-avatar" role="img" aria-label="${esc(displayName)}">
        <span class="e-avatar-letter" aria-hidden="true">${letter}</span>
        <div class="e-avatar-image" style="${avatarStyle}"></div>
      </div>
      <div class="e-name-block">
        <span class="e-name">${esc(displayName)}</span>
        <div class="e-subtitle">${subtitleParts.map(p => `<span>${esc(p)}</span>`).join('')}</div>
      </div>
      <div class="e-header-side">
        ${rank}
        <div class="mode-tabs" role="group" aria-label="分类表现视图">
          <label class="mode-tab" for="bk-mode-list">列表</label>
          ${radarTab}
        </div>
      </div>
    </header>

    <div class="uc-body">
      <section class="stat-grid" aria-label="数值概览">
        <div class="stat-tile"><div class="lbl">总评分</div><div class="val">${formatInt(stats.totalRating)}</div></div>
        <div class="stat-tile"><div class="lbl">作品</div><div class="val">${formatInt(stats.pageCount)}</div></div>
        <div class="stat-tile"><div class="lbl">投出 UpVote</div><div class="val">${formatInt(stats.votesUp)}</div></div>
        <div class="stat-tile"><div class="lbl">投出 DownVote</div><div class="val">${formatInt(stats.votesDown)}</div></div>
      </section>

      <section class="breakdown" aria-label="分类表现">
        <div class="breakdown-stage">
          <div class="breakdown-panel panel-list">${listHtml}</div>
          ${radarAvailable ? `<div class="breakdown-panel panel-radar">${radarHtml}</div>` : ''}
        </div>
      </section>
    </div>
  </div>`;
}

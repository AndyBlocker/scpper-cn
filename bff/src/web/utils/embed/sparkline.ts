export interface SparklineOptions {
  values: number[];
  width?: number;
  height?: number;
  stroke?: string;            // 线条颜色 (CSS 合法值)
  fill?: string;              // 面积填充色 (留空关闭)
  padding?: number;
  /** 是否把 y 轴 0 作为参考线 */
  showZeroAxis?: boolean;
}

function buildPath(values: number[], w: number, h: number, pad: number) {
  if (values.length === 0) return { line: '', area: '', zeroY: null as number | null };
  const n = values.length;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const usableW = Math.max(1, w - pad * 2);
  const usableH = Math.max(1, h - pad * 2);
  const stepX = n === 1 ? 0 : usableW / (n - 1);

  const pts: Array<[number, number]> = values.map((v, i) => {
    const x = pad + stepX * i;
    const y = pad + usableH - ((v - min) / range) * usableH;
    return [Number(x.toFixed(2)), Number(y.toFixed(2))];
  });

  const line = pts
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x} ${y}`)
    .join(' ');
  const area = `${line} L${pts[pts.length - 1][0]} ${pad + usableH} L${pts[0][0]} ${pad + usableH} Z`;

  const zeroY =
    min <= 0 && max >= 0
      ? Number((pad + usableH - ((0 - min) / range) * usableH).toFixed(2))
      : null;

  return { line, area, zeroY };
}

/**
 * 渲染一条窄幅 sparkline SVG，尺寸默认 120x28。
 * stroke/fill 接受 currentColor 或任何 CSS 颜色。
 */
export function renderSparkline(opts: SparklineOptions): string {
  const width = opts.width ?? 120;
  const height = opts.height ?? 28;
  const padding = opts.padding ?? 2;
  const stroke = opts.stroke || 'currentColor';
  const fill = opts.fill || 'none';

  const values = Array.isArray(opts.values) ? opts.values : [];
  if (values.length < 2) {
    // 退化：空或只有一个点时渲染一条水平基线
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
      <line x1="${padding}" y1="${height / 2}" x2="${width - padding}" y2="${height / 2}" stroke="${stroke}" stroke-opacity="0.4" stroke-dasharray="2 2"/>
    </svg>`;
  }

  const { line, area, zeroY } = buildPath(values, width, height, padding);

  const zeroAxis =
    opts.showZeroAxis && zeroY != null
      ? `<line x1="${padding}" x2="${width - padding}" y1="${zeroY}" y2="${zeroY}" stroke="${stroke}" stroke-opacity="0.25" stroke-dasharray="2 2"/>`
      : '';

  const areaEl =
    fill && fill !== 'none'
      ? `<path d="${area}" fill="${fill}" stroke="none"/>`
      : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
    ${zeroAxis}
    ${areaEl}
    <path d="${line}" fill="none" stroke="${stroke}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
  </svg>`;
}

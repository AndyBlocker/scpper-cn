export function formatNumber(num: number): string {
  if (num >= 10000) return (num / 10000).toFixed(1) + '万'
  return num.toLocaleString()
}

export function buildSparkLine(values: number[]) {
  if (!values || values.length < 2) return { line: '', area: '' }
  const minY = Math.min(...values)
  const maxY = Math.max(...values)
  const rangeY = maxY - minY || 1
  const points: string[] = []
  const n = values.length
  for (let i = 0; i < n; i++) {
    const x = 10 + 280 * (n === 1 ? 0 : (i / (n - 1)))
    const y = 50 - 40 * ((values[i] - minY) / rangeY)
    points.push(`${x.toFixed(1)},${y.toFixed(1)}`)
  }
  const line = points.join(' ')
  const area = `${line} 290,55 10,55`
  return { line, area }
}

export function getPercentilePosition(p?: { rank: number; total: number } | null) {
  if (!p || !p.rank || !p.total) return null
  const position = (p.total - p.rank + 1) / p.total
  return Math.round(position * 1000) / 10
}

export function normalizePeriod(period?: string | null) {
  const key = (period || '').toLowerCase()
  if (key.startsWith('year')) return 'year'
  if (key.startsWith('month')) return 'month'
  if (key.startsWith('week')) return 'week'
  if (key.startsWith('day')) return 'day'
  return key || 'other'
}

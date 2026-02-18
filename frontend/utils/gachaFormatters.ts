import type { GachaPool, MarketCategory, TicketBalance } from '~/types/gacha'

// ─── Token 格式化 ────────────────────────────────────────

export function formatTokens(value: number | null | undefined): string {
  const numeric = Number(value ?? 0)
  if (!Number.isFinite(numeric)) return '0'
  return numeric.toLocaleString()
}

export function formatTokenDecimal(value: number | null | undefined, digits = 2): string {
  const numeric = Number(value ?? 0)
  if (!Number.isFinite(numeric)) return '0'
  return numeric.toLocaleString('zh-CN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits
  })
}

export function formatSignedNumber(value: number | null | undefined, digits = 2): string {
  const numeric = Number(value ?? 0)
  if (!Number.isFinite(numeric)) return '0'
  const sign = numeric > 0 ? '+' : ''
  return `${sign}${numeric.toFixed(digits)}`
}

export function formatPrice(value: number | null | undefined): string {
  const numeric = Number(value ?? 0)
  if (!Number.isFinite(numeric)) return '0.0000'
  return numeric.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4
  })
}

export function formatPlacementPercent(value: number | null | undefined, digits = 2): string {
  const numeric = Number(value ?? 0)
  if (!Number.isFinite(numeric)) return '0%'
  return `${(numeric * 100).toFixed(digits)}%`
}

// ─── 日期格式化 ──────────────────────────────────────────

const dateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
})

export function formatDate(input: string | null): string {
  if (!input) return '未定'
  const date = new Date(input)
  if (Number.isNaN(date.getTime())) return input
  return date.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  })
}

export function formatDateCompact(input: string | null): string | null {
  if (!input) return null
  const date = new Date(input)
  if (Number.isNaN(date.getTime())) return null
  return dateTimeFormatter.format(date)
}

export function formatLagDuration(value: number | null | undefined): string {
  const ms = Number(value ?? NaN)
  if (!Number.isFinite(ms) || ms < 0) return '--'
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainMinutes = minutes % 60
  return remainMinutes > 0 ? `${hours}h ${remainMinutes}m` : `${hours}h`
}

export function formatBoostTime(startsAt: string | null, endsAt: string | null): string {
  const start = startsAt ? formatDate(startsAt) : '即刻生效'
  const end = endsAt ? formatDate(endsAt) : '无结束时间'
  return `${start} ~ ${end}`
}

// ─── 通用工具 ────────────────────────────────────────────

export function pnlClass(value: number | null | undefined): string {
  return Number(value ?? 0) >= 0
    ? 'text-emerald-600 dark:text-emerald-300'
    : 'text-rose-600 dark:text-rose-300'
}

export function progressPercent(progress: number, target: number): number {
  if (!target || target <= 0) return 0
  const ratio = (Number(progress || 0) / target) * 100
  return Math.max(0, Math.min(100, Number.isFinite(ratio) ? ratio : 0))
}

export function marketCategoryLabel(category: MarketCategory | string | null | undefined): string {
  switch (String(category || '').toUpperCase()) {
    case 'OVERALL': return '全站'
    case 'TRANSLATION': return '译文'
    case 'SCP': return 'SCP'
    case 'TALE': return '故事'
    case 'GOI': return 'GOI'
    case 'WANDERERS': return '图书馆'
    default: return String(category || '未知')
  }
}

export function normalizeTickets(payload?: Partial<TicketBalance> | null): TicketBalance {
  return {
    drawTicket: Math.max(0, Number(payload?.drawTicket ?? 0)),
    draw10Ticket: Math.max(0, Number(payload?.draw10Ticket ?? 0)),
    affixReforgeTicket: Math.max(0, Number(payload?.affixReforgeTicket ?? 0))
  }
}

export function toTimestamp(value: string | null | undefined): number | null {
  if (!value) return null
  const ts = new Date(value).getTime()
  return Number.isNaN(ts) ? null : ts
}

export type PoolStatusKey = 'active' | 'upcoming' | 'ended' | 'inactive'

export function poolStatusKey(pool: GachaPool): PoolStatusKey {
  const now = Date.now()
  if (pool.isActive) return 'active'
  const start = toTimestamp(pool.startsAt)
  const end = toTimestamp(pool.endsAt)
  if (start != null && start > now) return 'upcoming'
  if (end != null && end < now) return 'ended'
  return 'inactive'
}

export function resolvePoolRange(pool: GachaPool) {
  const start = formatDateCompact(pool.startsAt)
  const end = formatDateCompact(pool.endsAt)
  return {
    start: start || '未设置',
    end: end || '未设置',
    label: start && end ? `${start} ~ ${end}` : start ? `${start} 开始` : end ? `截止 ${end}` : '长期开放'
  }
}

export function tenDrawSavings(pool: GachaPool): number {
  const diff = pool.tokenCost * 10 - pool.tenDrawCost
  return diff > 0 ? diff : 0
}

export function emptyTickets(): TicketBalance {
  return {
    drawTicket: 0,
    draw10Ticket: 0,
    affixReforgeTicket: 0
  }
}

export function formatRewardSummary(reward: { tokens: number; tickets: TicketBalance }): string {
  const parts: string[] = []
  const tokens = Number(reward.tokens ?? 0)
  if (tokens > 0) parts.push(`${formatTokens(tokens)}T`)
  const draw = Number(reward.tickets?.drawTicket ?? 0)
  if (draw > 0) parts.push(`${draw}单抽`)
  const draw10 = Number(reward.tickets?.draw10Ticket ?? 0)
  if (draw10 > 0) parts.push(`${draw10}十连`)
  const reforge = Number(reward.tickets?.affixReforgeTicket ?? 0)
  if (reforge > 0) parts.push(`${reforge}改造`)
  return parts.length > 0 ? parts.join(' + ') : '0T'
}

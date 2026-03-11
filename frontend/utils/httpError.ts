const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object') return null
  return value as Record<string, unknown>
}

const pickString = (...values: unknown[]): string | null => {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value
  }
  return null
}

export function getErrorMessage(error: unknown, fallback: string): string {
  const record = asRecord(error)
  const data = asRecord(record?.data)
  return pickString(data?.error, data?.message, record?.message) ?? fallback
}

export function getErrorStatus(error: unknown): number | null {
  const record = asRecord(error)
  const raw = record?.status
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null
}

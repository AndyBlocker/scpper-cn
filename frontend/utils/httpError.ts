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
  const response = asRecord(record?.response)
  const data = asRecord(record?.data)
  const candidates = [
    record?.status,
    record?.statusCode,
    response?.status,
    data?.statusCode
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate
  }
  return null
}

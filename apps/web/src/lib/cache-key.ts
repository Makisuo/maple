import { snapTimestamp } from "@/lib/time-utils"

export function normalizeForKey(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value === "string") return snapTimestamp(value)
    return value
  }

  if (Array.isArray(value)) {
    return value.map(normalizeForKey)
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))

  const normalized: Record<string, unknown> = {}
  for (const [key, entryValue] of entries) {
    normalized[key] = normalizeForKey(entryValue)
  }

  return normalized
}

export function encodeKey(value: unknown): string {
  const normalized = normalizeForKey(value)
  return JSON.stringify(normalized === undefined ? null : normalized)
}

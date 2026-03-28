/**
 * Known fields that are Record<string, string> maps where keys contain dots
 * (e.g., logAttributes["http.method"]). When a field path starts with one of
 * these prefixes, the remaining segments are joined back with "." and used as
 * the map key instead of doing further object traversal.
 */
const KNOWN_MAP_FIELDS = [
  "rootSpan.attributes",
  "logAttributes",
  "resourceAttributes",
  "spanAttributes",
] as const

export function resolveFieldPath(
  row: Record<string, unknown>,
  fieldPath: string,
): unknown {
  for (const mapField of KNOWN_MAP_FIELDS) {
    const prefix = mapField + "."
    if (fieldPath.startsWith(prefix)) {
      const mapKey = fieldPath.slice(prefix.length)
      const map = mapField.includes(".")
        ? getNestedValue(row, mapField.split("."))
        : row[mapField]
      if (map != null && typeof map === "object") {
        return (map as Record<string, unknown>)[mapKey]
      }
      return undefined
    }
  }

  return getNestedValue(row, fieldPath.split("."))
}

function getNestedValue(obj: unknown, parts: string[]): unknown {
  let current: unknown = obj
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

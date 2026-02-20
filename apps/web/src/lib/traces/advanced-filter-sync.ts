export interface TracesSearchLike {
  services?: string[]
  spanNames?: string[]
  hasError?: boolean
  minDurationMs?: number
  maxDurationMs?: number
  httpMethods?: string[]
  httpStatusCodes?: string[]
  deploymentEnvs?: string[]
  startTime?: string
  endTime?: string
  rootOnly?: boolean
  whereClause?: string
  attributeKey?: string
  attributeValue?: string
}

interface ParsedWhereClauseFilters {
  service?: string
  spanName?: string
  deploymentEnv?: string
  httpMethod?: string
  httpStatusCode?: string
  hasError?: true
  rootOnly?: false
  minDurationMs?: number
  maxDurationMs?: number
  attributeKey?: string
  attributeValue?: string
}

const TRUE_VALUES = new Set(["1", "true", "yes", "y"])
const FALSE_VALUES = new Set(["0", "false", "no", "n"])

const CLAUSE_RE = /^([a-zA-Z0-9_.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+))$/

function firstNonEmpty(values?: string[]): string | undefined {
  if (!values || values.length === 0) {
    return undefined
  }

  const first = values[0]?.trim()
  return first ? first : undefined
}

function normalizeBoolean(value: unknown): boolean | undefined {
  if (typeof value !== "boolean") {
    return undefined
  }

  return value
}

function normalizeNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined
  }

  return value
}

function parseBoolean(value: string): boolean | null {
  const normalized = value.trim().toLowerCase()
  if (TRUE_VALUES.has(normalized)) {
    return true
  }

  if (FALSE_VALUES.has(normalized)) {
    return false
  }

  return null
}

function parseNumber(value: string): number | null {
  if (!value.trim()) {
    return null
  }

  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    return null
  }

  return parsed
}

function quoteValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/\"/g, '\\\"')}"`
}

function hasAnyFilter(filters: ParsedWhereClauseFilters): boolean {
  return Object.values(filters).some((value) => value !== undefined)
}

function parseWhereClause(whereClause: string | undefined): {
  filters: ParsedWhereClauseFilters
  hasIncompleteClauses: boolean
} {
  if (!whereClause || !whereClause.trim()) {
    return {
      filters: {},
      hasIncompleteClauses: false,
    }
  }

  const parts = whereClause
    .trim()
    .split(/\s+AND\s+/i)
    .map((part) => part.trim())
    .filter(Boolean)

  const parsed: ParsedWhereClauseFilters = {}
  let hasIncompleteClauses = false

  for (const part of parts) {
    const match = part.match(CLAUSE_RE)
    if (!match) {
      hasIncompleteClauses = true
      continue
    }

    const unquotedToken = match[4]
    if (
      unquotedToken &&
      (unquotedToken.startsWith("\"") || unquotedToken.startsWith("'"))
    ) {
      hasIncompleteClauses = true
      continue
    }

    const rawKey = match[1]?.trim().toLowerCase()
    const rawValue = (match[2] ?? match[3] ?? match[4] ?? "").trim()
    if (!rawKey || !rawValue) {
      continue
    }

    if (rawKey === "service" || rawKey === "service.name") {
      parsed.service = rawValue
      continue
    }

    if (rawKey === "span" || rawKey === "span.name") {
      parsed.spanName = rawValue
      continue
    }

    if (
      rawKey === "deployment.environment" ||
      rawKey === "environment" ||
      rawKey === "env"
    ) {
      parsed.deploymentEnv = rawValue
      continue
    }

    if (rawKey === "http.method") {
      parsed.httpMethod = rawValue
      continue
    }

    if (rawKey === "http.status_code") {
      parsed.httpStatusCode = rawValue
      continue
    }

    if (rawKey === "has_error") {
      const boolValue = parseBoolean(rawValue)
      if (boolValue === null) {
        hasIncompleteClauses = true
      } else {
        parsed.hasError = boolValue === true ? true : undefined
      }
      continue
    }

    if (rawKey === "root_only" || rawKey === "root.only") {
      const boolValue = parseBoolean(rawValue)
      if (boolValue === null) {
        hasIncompleteClauses = true
      } else {
        parsed.rootOnly = boolValue === false ? false : undefined
      }
      continue
    }

    if (rawKey === "min_duration_ms") {
      const numeric = parseNumber(rawValue)
      if (numeric === null) {
        hasIncompleteClauses = true
      } else {
        parsed.minDurationMs = numeric
      }
      continue
    }

    if (rawKey === "max_duration_ms") {
      const numeric = parseNumber(rawValue)
      if (numeric === null) {
        hasIncompleteClauses = true
      } else {
        parsed.maxDurationMs = numeric
      }
      continue
    }

    if (rawKey.startsWith("attr.")) {
      const attributeKey = rawKey.slice(5).trim()
      if (!attributeKey || parsed.attributeKey) {
        continue
      }

      parsed.attributeKey = attributeKey
      parsed.attributeValue = rawValue
    }
  }

  return {
    filters: parsed,
    hasIncompleteClauses,
  }
}

function toWhereClause(filters: ParsedWhereClauseFilters): string | undefined {
  const clauses: string[] = []

  if (filters.service) {
    clauses.push(`service.name = ${quoteValue(filters.service)}`)
  }

  if (filters.spanName) {
    clauses.push(`span.name = ${quoteValue(filters.spanName)}`)
  }

  if (filters.deploymentEnv) {
    clauses.push(`deployment.environment = ${quoteValue(filters.deploymentEnv)}`)
  }

  if (filters.httpMethod) {
    clauses.push(`http.method = ${quoteValue(filters.httpMethod)}`)
  }

  if (filters.httpStatusCode) {
    clauses.push(`http.status_code = ${quoteValue(filters.httpStatusCode)}`)
  }

  if (filters.hasError === true) {
    clauses.push("has_error = true")
  }

  if (filters.rootOnly === false) {
    clauses.push("root_only = false")
  }

  if (typeof filters.minDurationMs === "number") {
    clauses.push(`min_duration_ms = ${String(filters.minDurationMs)}`)
  }

  if (typeof filters.maxDurationMs === "number") {
    clauses.push(`max_duration_ms = ${String(filters.maxDurationMs)}`)
  }

  if (filters.attributeKey && filters.attributeValue) {
    clauses.push(
      `attr.${filters.attributeKey} = ${quoteValue(filters.attributeValue)}`,
    )
  }

  if (clauses.length === 0) {
    return undefined
  }

  return clauses.join(" AND ")
}

function normalizeLegacyFilters(search: TracesSearchLike): ParsedWhereClauseFilters {
  const service = firstNonEmpty(search.services)
  const spanName = firstNonEmpty(search.spanNames)
  const deploymentEnv = firstNonEmpty(search.deploymentEnvs)
  const httpMethod = firstNonEmpty(search.httpMethods)
  const httpStatusCode = firstNonEmpty(search.httpStatusCodes)
  const hasError = normalizeBoolean(search.hasError) === true ? true : undefined
  const rootOnly = normalizeBoolean(search.rootOnly) === false ? false : undefined
  const minDurationMs = normalizeNumber(search.minDurationMs)
  const maxDurationMs = normalizeNumber(search.maxDurationMs)
  const attributeKey = search.attributeKey?.trim()
  const attributeValue = search.attributeValue?.trim()

  return {
    service,
    spanName,
    deploymentEnv,
    httpMethod,
    httpStatusCode,
    hasError,
    rootOnly,
    minDurationMs,
    maxDurationMs,
    attributeKey: attributeKey && attributeValue ? attributeKey : undefined,
    attributeValue: attributeKey && attributeValue ? attributeValue : undefined,
  }
}

function normalizeWithFilters(
  search: TracesSearchLike,
  filters: ParsedWhereClauseFilters,
): TracesSearchLike {
  const whereClause = toWhereClause(filters)

  return {
    startTime: search.startTime,
    endTime: search.endTime,
    services: filters.service ? [filters.service] : undefined,
    spanNames: filters.spanName ? [filters.spanName] : undefined,
    hasError: filters.hasError,
    minDurationMs: filters.minDurationMs,
    maxDurationMs: filters.maxDurationMs,
    httpMethods: filters.httpMethod ? [filters.httpMethod] : undefined,
    httpStatusCodes: filters.httpStatusCode ? [filters.httpStatusCode] : undefined,
    deploymentEnvs: filters.deploymentEnv ? [filters.deploymentEnv] : undefined,
    rootOnly: filters.rootOnly,
    whereClause,
    attributeKey: filters.attributeKey,
    attributeValue: filters.attributeValue,
  }
}

export function normalizeTracesSearchParams(search: TracesSearchLike): TracesSearchLike {
  const normalizedWhereClause = search.whereClause?.trim()

  if (normalizedWhereClause) {
    const parsed = parseWhereClause(normalizedWhereClause)
    if (hasAnyFilter(parsed.filters)) {
      return normalizeWithFilters(search, parsed.filters)
    }

    if (parsed.hasIncompleteClauses) {
      return {
        startTime: search.startTime,
        endTime: search.endTime,
        whereClause: normalizedWhereClause,
      }
    }

    return normalizeWithFilters(search, {})
  }

  return normalizeWithFilters(search, normalizeLegacyFilters(search))
}

function sortedObject(input: TracesSearchLike): Record<string, unknown> {
  return {
    attributeKey: input.attributeKey,
    attributeValue: input.attributeValue,
    deploymentEnvs: input.deploymentEnvs,
    endTime: input.endTime,
    hasError: input.hasError,
    httpMethods: input.httpMethods,
    httpStatusCodes: input.httpStatusCodes,
    maxDurationMs: input.maxDurationMs,
    minDurationMs: input.minDurationMs,
    rootOnly: input.rootOnly,
    services: input.services,
    spanNames: input.spanNames,
    startTime: input.startTime,
    whereClause: input.whereClause,
  }
}

export function areTracesSearchParamsEqual(
  left: TracesSearchLike,
  right: TracesSearchLike,
): boolean {
  return JSON.stringify(sortedObject(left)) === JSON.stringify(sortedObject(right))
}

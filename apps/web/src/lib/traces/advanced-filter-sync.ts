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
  resourceAttributeKey?: string
  resourceAttributeValue?: string
  serviceMatchMode?: FilterMatchMode
  spanNameMatchMode?: FilterMatchMode
  deploymentEnvMatchMode?: FilterMatchMode
  attributeValueMatchMode?: FilterMatchMode
  resourceAttributeValueMatchMode?: FilterMatchMode
}

export type FilterMatchMode = "contains"

export interface ParsedWhereClauseFilters {
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
  resourceAttributeKey?: string
  resourceAttributeValue?: string
  matchModes?: Partial<Record<string, FilterMatchMode>>
}

const TRUE_VALUES = new Set(["1", "true", "yes", "y"])
const FALSE_VALUES = new Set(["0", "false", "no", "n"])

const CLAUSE_RE = /^([a-zA-Z0-9_.-]+)\s*(<=|>=|<|>|=|contains)\s*(?:"([^"]*)"|'([^']*)'|([^\s]+))$/i

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

export function parseWhereClause(whereClause: string | undefined): {
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

    const unquotedToken = match[5]
    if (
      unquotedToken &&
      (unquotedToken.startsWith("\"") || unquotedToken.startsWith("'"))
    ) {
      hasIncompleteClauses = true
      continue
    }

    const rawKey = match[1]?.trim().toLowerCase()
    const rawOperator = match[2]?.toLowerCase()
    const rawValue = (match[3] ?? match[4] ?? match[5] ?? "").trim()
    const isContains = rawOperator === "contains"
    if (!rawKey || !rawValue) {
      continue
    }

    function setMatchMode(key: string) {
      if (isContains) {
        parsed.matchModes ??= {}
        parsed.matchModes[key] = "contains"
      }
    }

    if (rawKey === "service" || rawKey === "service.name") {
      parsed.service = rawValue
      setMatchMode("service")
      continue
    }

    if (rawKey === "span" || rawKey === "span.name") {
      parsed.spanName = rawValue
      setMatchMode("spanName")
      continue
    }

    if (
      rawKey === "deployment.environment" ||
      rawKey === "environment" ||
      rawKey === "env"
    ) {
      parsed.deploymentEnv = rawValue
      setMatchMode("deploymentEnv")
      continue
    }

    if (rawKey === "http.method") {
      parsed.httpMethod = rawValue
      setMatchMode("httpMethod")
      continue
    }

    if (rawKey === "http.status_code") {
      parsed.httpStatusCode = rawValue
      setMatchMode("httpStatusCode")
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
      setMatchMode("attributeValue")
      continue
    }

    if (rawKey.startsWith("resource.")) {
      const resourceKey = rawKey.slice(9).trim()
      if (!resourceKey || parsed.resourceAttributeKey) {
        continue
      }

      parsed.resourceAttributeKey = resourceKey
      parsed.resourceAttributeValue = rawValue
      setMatchMode("resourceAttributeValue")
    }
  }

  return {
    filters: parsed,
    hasIncompleteClauses,
  }
}

export function toWhereClause(filters: ParsedWhereClauseFilters): string | undefined {
  const clauses: string[] = []
  const modes = filters.matchModes ?? {}

  function op(key: string): string {
    return modes[key] === "contains" ? "contains" : "="
  }

  if (filters.service) {
    clauses.push(`service.name ${op("service")} ${quoteValue(filters.service)}`)
  }

  if (filters.spanName) {
    clauses.push(`span.name ${op("spanName")} ${quoteValue(filters.spanName)}`)
  }

  if (filters.deploymentEnv) {
    clauses.push(`deployment.environment ${op("deploymentEnv")} ${quoteValue(filters.deploymentEnv)}`)
  }

  if (filters.httpMethod) {
    clauses.push(`http.method ${op("httpMethod")} ${quoteValue(filters.httpMethod)}`)
  }

  if (filters.httpStatusCode) {
    clauses.push(`http.status_code ${op("httpStatusCode")} ${quoteValue(filters.httpStatusCode)}`)
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
      `attr.${filters.attributeKey} ${op("attributeValue")} ${quoteValue(filters.attributeValue)}`,
    )
  }

  if (filters.resourceAttributeKey && filters.resourceAttributeValue) {
    clauses.push(
      `resource.${filters.resourceAttributeKey} ${op("resourceAttributeValue")} ${quoteValue(filters.resourceAttributeValue)}`,
    )
  }

  if (clauses.length === 0) {
    return undefined
  }

  return clauses.join(" AND ")
}

/**
 * One-way transform: parses a where clause string and merges the parsed
 * filter values into the search params. Does NOT reverse-sync checkboxes
 * back into whereClause text.
 */
export function applyWhereClause(
  search: TracesSearchLike,
  whereClause: string,
): TracesSearchLike {
  const trimmed = whereClause.trim()

  if (!trimmed) {
    return {
      ...search,
      whereClause: undefined,
      services: undefined,
      spanNames: undefined,
      hasError: undefined,
      minDurationMs: undefined,
      maxDurationMs: undefined,
      httpMethods: undefined,
      httpStatusCodes: undefined,
      deploymentEnvs: undefined,
      rootOnly: undefined,
      attributeKey: undefined,
      attributeValue: undefined,
      resourceAttributeKey: undefined,
      resourceAttributeValue: undefined,
      serviceMatchMode: undefined,
      spanNameMatchMode: undefined,
      deploymentEnvMatchMode: undefined,
      attributeValueMatchMode: undefined,
      resourceAttributeValueMatchMode: undefined,
    }
  }

  const { filters } = parseWhereClause(trimmed)
  const modes = filters.matchModes ?? {}

  return {
    ...search,
    whereClause: trimmed,
    services: filters.service ? [filters.service] : search.services,
    spanNames: filters.spanName ? [filters.spanName] : search.spanNames,
    hasError: filters.hasError ?? search.hasError,
    minDurationMs: filters.minDurationMs ?? search.minDurationMs,
    maxDurationMs: filters.maxDurationMs ?? search.maxDurationMs,
    httpMethods: filters.httpMethod ? [filters.httpMethod] : search.httpMethods,
    httpStatusCodes: filters.httpStatusCode ? [filters.httpStatusCode] : search.httpStatusCodes,
    deploymentEnvs: filters.deploymentEnv ? [filters.deploymentEnv] : search.deploymentEnvs,
    rootOnly: filters.rootOnly ?? search.rootOnly,
    attributeKey: filters.attributeKey ?? search.attributeKey,
    attributeValue: filters.attributeValue ?? search.attributeValue,
    resourceAttributeKey: filters.resourceAttributeKey ?? search.resourceAttributeKey,
    resourceAttributeValue: filters.resourceAttributeValue ?? search.resourceAttributeValue,
    serviceMatchMode: filters.service ? modes.service : search.serviceMatchMode,
    spanNameMatchMode: filters.spanName ? modes.spanName : search.spanNameMatchMode,
    deploymentEnvMatchMode: filters.deploymentEnv ? modes.deploymentEnv : search.deploymentEnvMatchMode,
    attributeValueMatchMode: filters.attributeValue ? modes.attributeValue : search.attributeValueMatchMode,
    resourceAttributeValueMatchMode: filters.resourceAttributeValue ? modes.resourceAttributeValue : search.resourceAttributeValueMatchMode,
  }
}

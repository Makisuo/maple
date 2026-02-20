import {
  QUERY_BUILDER_METRIC_TYPES,
  type QueryBuilderDataSource,
  type QueryBuilderMetricType,
} from "@/lib/query-builder/model"

export type WhereClauseAutocompleteContext =
  | "key"
  | "operator"
  | "value"
  | "conjunction"

export type WhereClauseAutocompleteScope = "default" | "trace_search"

export interface WhereClauseAutocompleteValues {
  services?: string[]
  spanNames?: string[]
  environments?: string[]
  commitShas?: string[]
  severities?: string[]
  httpMethods?: string[]
  httpStatusCodes?: string[]
  metricTypes?: QueryBuilderMetricType[]
  attributeKeys?: string[]
  attributeValues?: string[]
}

export interface WhereClauseAutocompleteSuggestion {
  id: string
  kind: WhereClauseAutocompleteContext
  label: string
  insertText: string
  description?: string
}

export interface WhereClauseAutocompleteResult {
  context: WhereClauseAutocompleteContext
  query: string
  key: string | null
  replaceStart: number
  replaceEnd: number
  suggestions: WhereClauseAutocompleteSuggestion[]
}

interface WhereClauseAutocompleteInput {
  expression: string
  cursor: number
  dataSource: QueryBuilderDataSource
  values?: WhereClauseAutocompleteValues
  scope?: WhereClauseAutocompleteScope
  maxSuggestions?: number
}

interface ApplyWhereClauseSuggestionInput {
  expression: string
  context: WhereClauseAutocompleteContext
  replaceStart: number
  replaceEnd: number
  suggestion: WhereClauseAutocompleteSuggestion
}

interface ParsedWhereClauseContext {
  context: WhereClauseAutocompleteContext
  key: string | null
  query: string
  replaceStart: number
  replaceEnd: number
}

interface KeyDefinition {
  label: string
  insertText: string
  description?: string
}

const KEY_DEFINITIONS: Record<QueryBuilderDataSource, KeyDefinition[]> = {
  traces: [
    {
      label: "service.name",
      insertText: "service.name",
      description: "Filter by service",
    },
    {
      label: "span.name",
      insertText: "span.name",
      description: "Filter by span name",
    },
    {
      label: "deployment.environment",
      insertText: "deployment.environment",
      description: "Filter by deployment environment",
    },
    {
      label: "deployment.commit_sha",
      insertText: "deployment.commit_sha",
      description: "Filter by commit sha",
    },
    {
      label: "root_only",
      insertText: "root_only",
      description: "true or false",
    },
    {
      label: "attr.<key>",
      insertText: "attr.",
      description: "Filter by a single span attribute",
    },
  ],
  logs: [
    {
      label: "service.name",
      insertText: "service.name",
      description: "Filter by service",
    },
    {
      label: "severity",
      insertText: "severity",
      description: "Filter by severity",
    },
  ],
  metrics: [
    {
      label: "service.name",
      insertText: "service.name",
      description: "Filter by service",
    },
    {
      label: "metric.type",
      insertText: "metric.type",
      description: "sum | gauge | histogram | exponential_histogram",
    },
  ],
}

const TRACE_SEARCH_KEY_DEFINITIONS: KeyDefinition[] = [
  {
    label: "service.name",
    insertText: "service.name",
    description: "Filter by service",
  },
  {
    label: "span.name",
    insertText: "span.name",
    description: "Filter by root span name",
  },
  {
    label: "deployment.environment",
    insertText: "deployment.environment",
    description: "Filter by deployment environment",
  },
  {
    label: "http.method",
    insertText: "http.method",
    description: "Filter by HTTP method",
  },
  {
    label: "http.status_code",
    insertText: "http.status_code",
    description: "Filter by HTTP status code",
  },
  {
    label: "has_error",
    insertText: "has_error",
    description: "true or false",
  },
  {
    label: "root_only",
    insertText: "root_only",
    description: "true or false",
  },
  {
    label: "min_duration_ms",
    insertText: "min_duration_ms",
    description: "Minimum duration in milliseconds",
  },
  {
    label: "max_duration_ms",
    insertText: "max_duration_ms",
    description: "Maximum duration in milliseconds",
  },
  {
    label: "attr.<key>",
    insertText: "attr.",
    description: "Filter by a single span attribute",
  },
]

function isSpace(char: string | undefined): boolean {
  return char == null || /\s/.test(char)
}

function clampCursor(expression: string, cursor: number): number {
  if (!Number.isFinite(cursor)) {
    return expression.length
  }

  return Math.min(Math.max(Math.trunc(cursor), 0), expression.length)
}

function findLastConjunctionBoundary(expression: string, cursor: number): number {
  let quote: "\"" | "'" | null = null
  let boundary = 0

  for (let index = 0; index < cursor; index += 1) {
    const char = expression[index]

    if (quote) {
      if (char === quote && expression[index - 1] !== "\\") {
        quote = null
      }
      continue
    }

    if (char === "\"" || char === "'") {
      quote = char
      continue
    }

    if (expression.slice(index, index + 3).toLowerCase() !== "and") {
      continue
    }

    const before = index === 0 ? undefined : expression[index - 1]
    const after = expression[index + 3]
    if (!isSpace(before) || !isSpace(after)) {
      continue
    }

    if (index + 3 <= cursor) {
      boundary = index + 3
      index += 2
    }
  }

  return boundary
}

function findFirstUnquotedEqual(segment: string): number {
  let quote: "\"" | "'" | null = null

  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index]

    if (quote) {
      if (char === quote && segment[index - 1] !== "\\") {
        quote = null
      }
      continue
    }

    if (char === "\"" || char === "'") {
      quote = char
      continue
    }

    if (char === "=") {
      return index
    }
  }

  return -1
}

function findClosingQuote(input: string, quote: "\"" | "'"): number {
  for (let index = 1; index < input.length; index += 1) {
    if (input[index] === quote && input[index - 1] !== "\\") {
      return index
    }
  }

  return -1
}

function parseWhereClauseContext(
  expression: string,
  cursor: number,
): ParsedWhereClauseContext {
  const cursorPosition = clampCursor(expression, cursor)
  const segmentStart = findLastConjunctionBoundary(expression, cursorPosition)
  const segment = expression.slice(segmentStart, cursorPosition)
  const leadingWhitespace = segment.match(/^\s*/)?.[0].length ?? 0
  const trimmedSegment = segment.slice(leadingWhitespace)

  if (!trimmedSegment) {
    return {
      context: "key",
      query: "",
      key: null,
      replaceStart: cursorPosition,
      replaceEnd: cursorPosition,
    }
  }

  const equalIndex = findFirstUnquotedEqual(trimmedSegment)
  if (equalIndex === -1) {
    const keyPattern = trimmedSegment.match(/^([^\s=]+)(\s*)(.*)$/)

    if (!keyPattern) {
      const query = trimmedSegment.trim()
      return {
        context: "key",
        query,
        key: null,
        replaceStart: cursorPosition - query.length,
        replaceEnd: cursorPosition,
      }
    }

    const keyToken = keyPattern[1]
    const keyGap = keyPattern[2]
    const operatorTail = keyPattern[3]
    const keyStart = segmentStart + leadingWhitespace

    if (!keyGap && operatorTail.length === 0) {
      return {
        context: "key",
        query: keyToken,
        key: null,
        replaceStart: keyStart,
        replaceEnd: cursorPosition,
      }
    }

    const operatorQuery = operatorTail.trimStart()
    const operatorLeadingWhitespace = operatorTail.length - operatorQuery.length

    return {
      context: "operator",
      query: operatorQuery,
      key: keyToken,
      replaceStart:
        keyStart +
        keyToken.length +
        keyGap.length +
        operatorLeadingWhitespace,
      replaceEnd: cursorPosition,
    }
  }

  const keyToken = trimmedSegment.slice(0, equalIndex).trim()
  if (!keyToken) {
    return {
      context: "key",
      query: "",
      key: null,
      replaceStart: cursorPosition,
      replaceEnd: cursorPosition,
    }
  }

  const valueTail = trimmedSegment.slice(equalIndex + 1)
  const valueTailLeadingWhitespace = valueTail.match(/^\s*/)?.[0].length ?? 0
  const trimmedValueTail = valueTail.slice(valueTailLeadingWhitespace)
  const valueStart =
    segmentStart + leadingWhitespace + equalIndex + 1 + valueTailLeadingWhitespace

  if (!trimmedValueTail) {
    return {
      context: "value",
      query: "",
      key: keyToken,
      replaceStart: cursorPosition,
      replaceEnd: cursorPosition,
    }
  }

  const firstValueChar = trimmedValueTail[0]
  if (firstValueChar === "\"" || firstValueChar === "'") {
    const closingQuote = findClosingQuote(
      trimmedValueTail,
      firstValueChar as "\"" | "'",
    )

    if (closingQuote === -1) {
      return {
        context: "value",
        query: trimmedValueTail.slice(1),
        key: keyToken,
        replaceStart: valueStart + 1,
        replaceEnd: cursorPosition,
      }
    }

    const trailing = trimmedValueTail.slice(closingQuote + 1)
    if (!trailing.trim()) {
      return {
        context: "conjunction",
        query: "",
        key: keyToken,
        replaceStart: cursorPosition,
        replaceEnd: cursorPosition,
      }
    }

    const trailingLeadingWhitespace = trailing.match(/^\s*/)?.[0].length ?? 0

    return {
      context: "conjunction",
      query: trailing.slice(trailingLeadingWhitespace),
      key: keyToken,
      replaceStart: valueStart + closingQuote + 1 + trailingLeadingWhitespace,
      replaceEnd: cursorPosition,
    }
  }

  const unquotedValue = trimmedValueTail.match(/^(\S+)(.*)$/)
  if (!unquotedValue) {
    return {
      context: "value",
      query: "",
      key: keyToken,
      replaceStart: cursorPosition,
      replaceEnd: cursorPosition,
    }
  }

  const valueToken = unquotedValue[1]
  const trailing = unquotedValue[2]

  if (!trailing) {
    return {
      context: "value",
      query: valueToken,
      key: keyToken,
      replaceStart: valueStart,
      replaceEnd: cursorPosition,
    }
  }

  if (!trailing.trim()) {
    return {
      context: "conjunction",
      query: "",
      key: keyToken,
      replaceStart: cursorPosition,
      replaceEnd: cursorPosition,
    }
  }

  const trailingLeadingWhitespace = trailing.match(/^\s*/)?.[0].length ?? 0

  return {
    context: "conjunction",
    query: trailing.slice(trailingLeadingWhitespace),
    key: keyToken,
    replaceStart: valueStart + valueToken.length + trailingLeadingWhitespace,
    replaceEnd: cursorPosition,
  }
}

function toSuggestion(
  suggestion: Omit<WhereClauseAutocompleteSuggestion, "kind">,
  kind: WhereClauseAutocompleteContext,
): WhereClauseAutocompleteSuggestion {
  return {
    kind,
    ...suggestion,
  }
}

function normalizeKey(input: string | null): string {
  if (!input) {
    return ""
  }

  const normalized = input.trim().toLowerCase()
  if (normalized === "service") return "service.name"
  if (normalized === "span") return "span.name"
  if (
    normalized === "deployment.environment" ||
    normalized === "environment" ||
    normalized === "env"
  ) {
    return "deployment.environment"
  }

  if (normalized === "deployment.commit_sha" || normalized === "commit_sha") {
    return "deployment.commit_sha"
  }

  if (normalized === "root_only" || normalized === "root.only") {
    return "root_only"
  }

  if (normalized === "has_error") {
    return "has_error"
  }

  if (normalized === "http.method") {
    return "http.method"
  }

  if (normalized === "http.status_code") {
    return "http.status_code"
  }

  if (normalized === "min_duration_ms") {
    return "min_duration_ms"
  }

  if (normalized === "max_duration_ms") {
    return "max_duration_ms"
  }

  if (normalized.startsWith("attr.")) {
    return "attr.*"
  }

  return normalized
}

function filterAndRankSuggestions(
  suggestions: WhereClauseAutocompleteSuggestion[],
  query: string,
  maxSuggestions: number,
): WhereClauseAutocompleteSuggestion[] {
  const normalizedQuery = query.trim().toLowerCase()

  const ranked = suggestions
    .map((suggestion, index) => {
      if (!normalizedQuery) {
        return {
          index,
          score: 0,
          suggestion,
        }
      }

      const normalizedLabel = suggestion.label.toLowerCase()
      const normalizedInsert = suggestion.insertText.toLowerCase()

      if (
        normalizedLabel.startsWith(normalizedQuery) ||
        normalizedInsert.startsWith(normalizedQuery)
      ) {
        return {
          index,
          score: 0,
          suggestion,
        }
      }

      if (
        normalizedLabel.includes(normalizedQuery) ||
        normalizedInsert.includes(normalizedQuery)
      ) {
        return {
          index,
          score: 1,
          suggestion,
        }
      }

      return {
        index,
        score: 99,
        suggestion,
      }
    })
    .filter((entry) => entry.score < 99)
    .sort((left, right) => {
      if (left.score !== right.score) {
        return left.score - right.score
      }

      return left.index - right.index
    })

  return ranked.slice(0, maxSuggestions).map((entry) => entry.suggestion)
}

function uniqueValues(values: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []

  for (const value of values) {
    const next = value.trim()
    if (!next || seen.has(next)) {
      continue
    }

    seen.add(next)
    result.push(next)
  }

  return result
}

function toStringValueSuggestion(
  value: string,
  idPrefix: string,
): WhereClauseAutocompleteSuggestion {
  return {
    id: `${idPrefix}:${value}`,
    kind: "value",
    label: value,
    insertText: `"${value.replace(/\\/g, "\\\\").replace(/\"/g, '\\\"')}"`,
  }
}

function buildValueSuggestions(
  key: string | null,
  dataSource: QueryBuilderDataSource,
  values: WhereClauseAutocompleteValues | undefined,
  scope: WhereClauseAutocompleteScope,
): WhereClauseAutocompleteSuggestion[] {
  const normalizedKey = normalizeKey(key)

  if (normalizedKey === "root_only") {
    return [
      {
        id: "value:true",
        kind: "value",
        label: "true",
        insertText: "true",
      },
      {
        id: "value:false",
        kind: "value",
        label: "false",
        insertText: "false",
      },
    ]
  }

  if (scope === "trace_search" && normalizedKey === "has_error") {
    return [
      {
        id: "value:has_error:true",
        kind: "value",
        label: "true",
        insertText: "true",
      },
      {
        id: "value:has_error:false",
        kind: "value",
        label: "false",
        insertText: "false",
      },
    ]
  }

  if (normalizedKey === "metric.type") {
    const metricTypes =
      values?.metricTypes && values.metricTypes.length > 0
        ? values.metricTypes
        : [...QUERY_BUILDER_METRIC_TYPES]

    return metricTypes.map((type) => toStringValueSuggestion(type, "metricType"))
  }

  const mappedValues: Record<string, string[]> = {
    "service.name": uniqueValues(values?.services ?? []),
    "span.name": uniqueValues(values?.spanNames ?? []),
    "deployment.environment": uniqueValues(values?.environments ?? []),
    "deployment.commit_sha": uniqueValues(values?.commitShas ?? []),
    severity: uniqueValues(values?.severities ?? []),
    ...(scope === "trace_search"
      ? {
          "http.method": uniqueValues(values?.httpMethods ?? []),
          "http.status_code": uniqueValues(values?.httpStatusCodes ?? []),
        }
      : {}),
  }

  const explicit = mappedValues[normalizedKey]
  if (explicit) {
    return explicit.map((value) => toStringValueSuggestion(value, normalizedKey))
  }

  if (normalizedKey === "" && dataSource === "metrics") {
    return [...QUERY_BUILDER_METRIC_TYPES].map((type) =>
      toStringValueSuggestion(type, "metricType"),
    )
  }

  if (normalizedKey === "attr.*" && values?.attributeValues) {
    return uniqueValues(values.attributeValues).map((value) =>
      toStringValueSuggestion(value, "attr"),
    )
  }

  return []
}

const NOISY_ATTR_PREFIXES = [
  "http.request.header.",
  "http.response.header.",
]

function isNoisyAttributeKey(key: string): boolean {
  return NOISY_ATTR_PREFIXES.some((prefix) => key.startsWith(prefix))
}

function buildAttributeKeySuggestions(
  attributeKeys: string[],
): WhereClauseAutocompleteSuggestion[] {
  const clean: WhereClauseAutocompleteSuggestion[] = []
  const noisy: WhereClauseAutocompleteSuggestion[] = []

  for (const key of attributeKeys) {
    const suggestion: WhereClauseAutocompleteSuggestion = {
      id: `key:attr.${key}`,
      kind: "key",
      label: `attr.${key}`,
      insertText: `attr.${key}`,
      description: "Span attribute",
    }

    if (isNoisyAttributeKey(key)) {
      noisy.push(suggestion)
    } else {
      clean.push(suggestion)
    }
  }

  return [...clean, ...noisy]
}

function buildSuggestions(
  parsed: ParsedWhereClauseContext,
  dataSource: QueryBuilderDataSource,
  values: WhereClauseAutocompleteValues | undefined,
  scope: WhereClauseAutocompleteScope,
  maxSuggestions: number,
): WhereClauseAutocompleteSuggestion[] {
  if (parsed.context === "key") {
    const query = parsed.query.toLowerCase()

    // When typing attr., show dynamic attribute keys instead of static definitions
    if (
      dataSource === "traces" &&
      query.startsWith("attr.") &&
      values?.attributeKeys &&
      values.attributeKeys.length > 0
    ) {
      const attrSuggestions = buildAttributeKeySuggestions(values.attributeKeys)
      return filterAndRankSuggestions(attrSuggestions, query, maxSuggestions)
    }

    const keyDefinitions =
      scope === "trace_search" && dataSource === "traces"
        ? TRACE_SEARCH_KEY_DEFINITIONS
        : KEY_DEFINITIONS[dataSource]

    const keySuggestions = keyDefinitions.map((keyDef) =>
      toSuggestion(
        {
          id: `key:${keyDef.insertText}`,
          label: keyDef.label,
          insertText: keyDef.insertText,
          description: keyDef.description,
        },
        "key",
      ),
    )

    return filterAndRankSuggestions(keySuggestions, parsed.query, maxSuggestions)
  }

  if (parsed.context === "operator") {
    const operatorSuggestions: WhereClauseAutocompleteSuggestion[] = [
      {
        id: "operator:equal",
        kind: "operator",
        label: "=",
        insertText: "=",
        description: "Equality operator",
      },
    ]

    return filterAndRankSuggestions(operatorSuggestions, parsed.query, maxSuggestions)
  }

  if (parsed.context === "value") {
    const valueSuggestions = buildValueSuggestions(
      parsed.key,
      dataSource,
      values,
      scope,
    )
    return filterAndRankSuggestions(valueSuggestions, parsed.query, maxSuggestions)
  }

  const conjunctionSuggestions: WhereClauseAutocompleteSuggestion[] = [
    {
      id: "conjunction:and",
      kind: "conjunction",
      label: "AND",
      insertText: "AND",
      description: "Add another clause",
    },
  ]

  return filterAndRankSuggestions(conjunctionSuggestions, parsed.query, maxSuggestions)
}

export function getWhereClauseAutocomplete({
  expression,
  cursor,
  dataSource,
  values,
  scope = "default",
  maxSuggestions = 8,
}: WhereClauseAutocompleteInput): WhereClauseAutocompleteResult {
  const parsed = parseWhereClauseContext(expression, cursor)
  const suggestions = buildSuggestions(parsed, dataSource, values, scope, maxSuggestions)

  return {
    context: parsed.context,
    query: parsed.query,
    key: parsed.key,
    replaceStart: parsed.replaceStart,
    replaceEnd: parsed.replaceEnd,
    suggestions,
  }
}

function clampRange(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max))
}

export function applyWhereClauseSuggestion({
  expression,
  context,
  replaceStart,
  replaceEnd,
  suggestion,
}: ApplyWhereClauseSuggestionInput): {
  expression: string
  cursor: number
} {
  const safeStart = clampRange(replaceStart, 0, expression.length)
  const safeEnd = clampRange(replaceEnd, safeStart, expression.length)
  const before = expression.slice(0, safeStart)
  const after = expression.slice(safeEnd)

  if (context === "operator") {
    const left = before.replace(/\s*$/, "")
    const right = after.replace(/^\s*/, "")
    const insertion = ` ${suggestion.insertText} `
    const nextExpression = `${left}${insertion}${right}`

    return {
      expression: nextExpression,
      cursor: left.length + insertion.length,
    }
  }

  if (context === "conjunction") {
    const left = before.replace(/\s*$/, "")
    const right = after.replace(/^\s*/, "")
    const insertion = ` ${suggestion.insertText} `
    const nextExpression = `${left}${insertion}${right}`

    return {
      expression: nextExpression,
      cursor: left.length + insertion.length,
    }
  }

  const shouldAddLeadingSpace = before.length > 0 && !/\s$/.test(before)
  const isPrefix = suggestion.insertText.endsWith(".")
  const shouldAddTrailingSpace =
    !isPrefix && (after.length === 0 || !/^\s/.test(after))
  const insertion = `${shouldAddLeadingSpace ? " " : ""}${
    suggestion.insertText
  }${shouldAddTrailingSpace ? " " : ""}`

  const nextExpression = `${before}${insertion}${after}`

  return {
    expression: nextExpression,
    cursor: before.length + insertion.length,
  }
}

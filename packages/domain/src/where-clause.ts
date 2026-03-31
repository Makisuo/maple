import { Match, Schema } from "effect"

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const Operator = Schema.Literals([
  "=",
  ">",
  "<",
  ">=",
  "<=",
  "contains",
  "exists",
])
export type Operator = Schema.Schema.Type<typeof Operator>

export const ParsedClause = Schema.Struct({
  key: Schema.String,
  operator: Operator,
  value: Schema.String,
})
export type ParsedClause = Schema.Schema.Type<typeof ParsedClause>

export class WhereClauseParseWarning extends Schema.TaggedErrorClass<WhereClauseParseWarning>()(
  "WhereClauseParseWarning",
  {
    message: Schema.String,
    clause: Schema.String,
  },
) {}

// ---------------------------------------------------------------------------
// Key alias normalization (single source of truth)
// ---------------------------------------------------------------------------

export const normalizeKey = (raw: string): string =>
  Match.value(raw.trim().toLowerCase()).pipe(
    Match.when("service", () => "service.name"),
    Match.when("span", () => "span.name"),
    Match.whenOr("environment", "env", () => "deployment.environment"),
    Match.when("commit_sha", () => "deployment.commit_sha"),
    Match.when("root.only", () => "root_only"),
    Match.when("errors_only", () => "has_error"),
    Match.orElse((k) => k),
  )

// ---------------------------------------------------------------------------
// Shared parsing helpers
// ---------------------------------------------------------------------------

const TRUE_VALUES = new Set(["1", "true", "yes", "y"])
const FALSE_VALUES = new Set(["0", "false", "no", "n"])

export function parseBoolean(value: string): boolean | null {
  const normalized = value.trim().toLowerCase()
  if (TRUE_VALUES.has(normalized)) return true
  if (FALSE_VALUES.has(normalized)) return false
  return null
}

export function parseNumber(value: string): number | null {
  if (!value.trim()) return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return null
  return parsed
}

export function splitCsv(input: string): string[] {
  return input
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

// ---------------------------------------------------------------------------
// Where-clause parser
// ---------------------------------------------------------------------------

export interface ParseWhereClauseResult {
  clauses: readonly ParsedClause[]
  warnings: readonly WhereClauseParseWarning[]
}

export function parseWhereClause(expression: string): ParseWhereClauseResult {
  const trimmed = expression.trim()
  if (!trimmed) {
    return { clauses: [], warnings: [] }
  }

  const parts = trimmed
    .split(/\s+AND\s+/i)
    .map((part) => part.trim())
    .filter(Boolean)

  const clauses: ParsedClause[] = []
  const warnings: WhereClauseParseWarning[] = []

  for (const part of parts) {
    // Try "exists" operator first (no value)
    const existsMatch = part.match(/^([a-zA-Z0-9_.-]+)\s+exists$/i)
    if (existsMatch) {
      clauses.push({
        key: existsMatch[1].trim().toLowerCase(),
        operator: "exists",
        value: "",
      })
      continue
    }

    // Try "contains" operator
    const containsMatch = part.match(
      /^([a-zA-Z0-9_.-]+)\s+contains\s+(?:"([^"]*)"|'([^']*)'|([^\s]+))$/i,
    )
    if (containsMatch) {
      clauses.push({
        key: containsMatch[1].trim().toLowerCase(),
        operator: "contains",
        value: (containsMatch[2] ?? containsMatch[3] ?? containsMatch[4] ?? "").trim(),
      })
      continue
    }

    // Try comparison operators: <=, >=, <, >, =
    const compMatch = part.match(
      /^([a-zA-Z0-9_.-]+)\s*(<=|>=|<|>|=)\s*(?:"([^"]*)"|'([^']*)'|([^\s]+))$/,
    )
    if (compMatch) {
      const unquotedToken = compMatch[5]
      // Detect unclosed quote in unquoted capture
      if (
        unquotedToken &&
        (unquotedToken.startsWith('"') || unquotedToken.startsWith("'"))
      ) {
        warnings.push(
          new WhereClauseParseWarning({
            message: `Unclosed quote in clause: ${part}`,
            clause: part,
          }),
        )
        continue
      }

      clauses.push({
        key: compMatch[1].trim().toLowerCase(),
        operator: compMatch[2] as Operator,
        value: (compMatch[3] ?? compMatch[4] ?? compMatch[5] ?? "").trim(),
      })
      continue
    }

    // Unparseable clause
    warnings.push(
      new WhereClauseParseWarning({
        message: `Unsupported clause syntax ignored: ${part}`,
        clause: part,
      }),
    )
  }

  return { clauses, warnings }
}

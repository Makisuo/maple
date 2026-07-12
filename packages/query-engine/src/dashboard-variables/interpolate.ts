// ---------------------------------------------------------------------------
// Dashboard variable interpolation
//
// Resolves `$name` / `${name}` references inside widget data-source params
// before the query is dispatched. Pure module — fully unit-testable.
//
// Variable names always start with a letter (enforced by the domain schema),
// so references can never collide with the `$__` built-in macros
// ($__startTime, $__timeFilter(...), ...), which are left untouched for the
// backend raw-SQL macro expansion.
//
// Formatting is key-aware:
//   - `sql` values get self-quoted, escaped ClickHouse string literals so a
//     crafted variable value cannot break out of its literal position.
//   - `whereClause`-like values are handled clause-by-clause: a clause that
//     references an "All" selection is dropped entirely (All = don't filter).
//   - everything else gets plain text substitution.
// ---------------------------------------------------------------------------

import { escapeClickHouseString } from "../sql"
import { splitWhereClause } from "../where-clause"

/** Sentinel for the "All" selection, both in URLs and resolved values. */
export const ALL_VALUE = "$__all"

export interface ResolvedVariable {
	/** The selected value, or `ALL_VALUE` when the All option is active. */
	value: string
	isAll: boolean
	/** Current option list — used to expand an All selection inside SQL `IN ($var)`. */
	options: string[]
}

export type VariableValues = Record<string, ResolvedVariable | undefined>

// `${name}` first so the branch consumes the braces; both forms require a
// leading letter, which is what keeps `$__` macros out of reach.
const VAR_REF = /\$\{([A-Za-z][A-Za-z0-9_]*)\}|\$([A-Za-z][A-Za-z0-9_]*)/g

const WHERE_CLAUSE_KEY = /whereclause$/i

function sqlLiteral(variable: ResolvedVariable): string {
	if (variable.isAll) {
		if (variable.options.length === 0) return "''"
		return variable.options.map((option) => `'${escapeClickHouseString(option)}'`).join(",")
	}
	return `'${escapeClickHouseString(variable.value)}'`
}

function replaceRefs(input: string, resolve: (name: string) => string | null): string {
	return input.replace(VAR_REF, (match, braced: string | undefined, bare: string | undefined) => {
		const replacement = resolve(braced ?? bare ?? "")
		// Unknown (or deleted) variable: keep the reference literal so the query
		// returns no rows instead of silently matching everything.
		return replacement ?? match
	})
}

/** Extract every `$name` / `${name}` reference in a string. */
export function collectVariableRefs(input: string): string[] {
	const names: string[] = []
	for (const match of input.matchAll(VAR_REF)) {
		const name = match[1] ?? match[2]
		if (name && !names.includes(name)) names.push(name)
	}
	return names
}

// A whereClause is `clause AND clause AND ...` (the grammar has no OR). An
// "All" selection means "don't filter on this at all", so the clause carrying
// the reference is removed rather than substituted. Splitting uses the
// engine's where-clause grammar, so a quoted value containing " and " is
// never mis-split.
function interpolateWhereClause(input: string, values: VariableValues): string {
	const kept: string[] = []
	for (const clause of splitWhereClause(input)) {
		const refs = collectVariableRefs(clause)
		const dropped = refs.some((name) => values[name]?.isAll === true)
		if (dropped) continue
		kept.push(replaceRefs(clause, (name) => {
			const variable = values[name]
			return variable === undefined ? null : variable.value
		}))
	}
	return kept.join(" AND ")
}

function interpolateString(input: string, key: string | undefined, values: VariableValues): string {
	if (!input.includes("$")) return input
	if (key === "sql") {
		return replaceRefs(input, (name) => {
			const variable = values[name]
			return variable === undefined ? null : sqlLiteral(variable)
		})
	}
	if (key !== undefined && WHERE_CLAUSE_KEY.test(key)) {
		return interpolateWhereClause(input, values)
	}
	return replaceRefs(input, (name) => {
		const variable = values[name]
		if (variable === undefined) return null
		return variable.isAll ? variable.options.join(",") : variable.value
	})
}

function walk(value: unknown, key: string | undefined, values: VariableValues): unknown {
	if (typeof value === "string") return interpolateString(value, key, values)
	if (Array.isArray(value)) return value.map((item) => walk(item, key, values))
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {}
		for (const [childKey, childValue] of Object.entries(value)) {
			out[childKey] = walk(childValue, childKey, values)
		}
		return out
	}
	return value
}

/**
 * Deep-interpolate `$name` references throughout widget params. Nested
 * structures (e.g. `queries[i].whereClause`) inherit the nearest object key
 * for format selection.
 */
export function interpolateWidgetParams(
	params: Record<string, unknown>,
	values: VariableValues,
): Record<string, unknown> {
	const result: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(params)) {
		result[key] = walk(value, key, values)
	}
	return result
}

/**
 * Interpolate references in user-facing display text (widget titles,
 * descriptions). Unlike query interpolation, an "All" selection renders as
 * the word "All" — not the expanded value list.
 */
export function interpolateDisplayText(text: string, values: VariableValues): string {
	if (!text.includes("$")) return text
	return replaceRefs(text, (name) => {
		const variable = values[name]
		if (variable === undefined) return null
		return variable.isAll ? "All" : variable.value
	})
}

/**
 * True when the params reference a *defined* variable that has no resolved
 * value yet (query-variable options still loading and nothing pins a value).
 * Widget fetches gate on this so a literal `$service` never reaches the API.
 */
export function hasUnresolvedVariableRefs(
	params: Record<string, unknown> | undefined,
	definedNames: ReadonlyArray<string>,
	values: VariableValues,
): boolean {
	if (!params || definedNames.length === 0) return false
	const refs = collectVariableRefs(JSON.stringify(params))
	return refs.some((name) => definedNames.includes(name) && values[name] === undefined)
}

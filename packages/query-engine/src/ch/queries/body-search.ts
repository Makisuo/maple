// ---------------------------------------------------------------------------
// Log body search - token pre-filter + substring predicate
//
// `Body ILIKE '%term%'` is substring-matching and scans whole partitions. The
// `logs.idx_body_tokens` skip index (`tokenbf_v1` over `lower(Body)`) can prune
// granules, but only via whole-token `hasToken(...)` predicates. Whole-token
// semantics are NOT the same as substring semantics, so we can only AND a
// `hasToken` pre-filter for tokens that are *guaranteed* to appear as whole
// tokens whenever the substring matches - otherwise we would silently drop rows.
//
// The final `ILIKE` predicate always stays, so the user-visible result set is
// byte-for-byte unchanged; the token predicates are a pure granule-pruning
// accelerator that the query planner is free to satisfy from the index.
// ---------------------------------------------------------------------------

import * as CH from "@maple-dev/clickhouse-builder/expr"

/** At most this many token pre-filters (diminishing pruning, longer SQL). */
const MAX_TOKENS = 4

const NON_ASCII = /[^\x00-\x7F]/
const ALNUM_RUN = /[A-Za-z0-9]+/g

/**
 * Tokens of `term` that are safe to AND as a `hasToken(lower(Body), token)`
 * pre-filter without changing the substring semantics of `Body ILIKE '%term%'`.
 *
 * Soundness: if `term` occurs as a substring of `Body`, an alphanumeric run of
 * `term` is guaranteed to be a *whole* ClickHouse token of `Body` only when it
 * is bounded on BOTH sides - within `term` itself - by a definite token
 * separator. An edge run (touching the start/end of `term`) could be extended
 * inside `Body` (`"conn"` inside `"connection"`), so it is unsafe.
 *
 * Conservative choices (each only ever drops an optimization, never a result):
 *   - ASCII-only: JS `String.toLowerCase()` and ClickHouse `lower()` agree on
 *     case folding for ASCII; outside ASCII they diverge, so bail entirely.
 *   - `_` is NOT treated as a separator. ClickHouse's tokenizer treatment of
 *     underscore is version-dependent; requiring boundaries in `[^A-Za-z0-9_]`
 *     keeps us correct whether or not `_` splits tokens.
 */
export function extractSafeSearchTokens(term: string): string[] {
	if (NON_ASCII.test(term)) return []

	const tokens: string[] = []
	const seen = new Set<string>()
	ALNUM_RUN.lastIndex = 0
	let match: RegExpExecArray | null
	while ((match = ALNUM_RUN.exec(term)) !== null) {
		const start = match.index
		const end = start + match[0].length
		// A maximal `[A-Za-z0-9]+` run's neighbours (if present) are non-
		// alphanumeric. Require both neighbours to exist and to be a definite
		// separator - i.e. present and not `_`. A missing neighbour = term edge.
		const leftBounded = start > 0 && term[start - 1] !== "_"
		const rightBounded = end < term.length && term[end] !== "_"
		if (!leftBounded || !rightBounded) continue

		const token = match[0].toLowerCase()
		if (seen.has(token)) continue
		seen.add(token)
		tokens.push(token)
		if (tokens.length >= MAX_TOKENS) break
	}
	return tokens
}

/**
 * Conditions for a log body search: safe `hasToken` pre-filters (index-prunable)
 * followed by the substring `ILIKE` that fixes the exact semantics. Spread into
 * a query's `where` array. When no safe token exists (e.g. a single word) this
 * degrades to just the `ILIKE`, i.e. today's behavior.
 */
export function bodySearchConditions(body: CH.Expr<string>, term: string): CH.Condition[] {
	const loweredBody = CH.lower_(body)
	const conditions: CH.Condition[] = extractSafeSearchTokens(term).map((token) =>
		CH.hasToken(loweredBody, CH.lit(token)),
	)
	conditions.push(body.ilike(`%${term}%`))
	return conditions
}

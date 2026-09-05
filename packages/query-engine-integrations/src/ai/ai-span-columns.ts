// The session's usage, summed the way the detail page sums it.
//
// `ai_trace_index` carries every GenAI span's tokens and cost (migration
// 0026, `@maple/domain/tinybird/gen-ai-columns`), and several frameworks
// stamp `gen_ai.usage.*` on the model span AND sum it onto the agent span that
// wraps it — counting both doubles every number. `countableUsageSpans` in
// `apps/web/src/lib/agent-sessions/session-summary.ts` charges each reporter
// to its nearest reporting ancestor and keeps only the excess; this is that
// rule in SQL, one level deep, which is the shape every roll-up in production
// has.

import type { Expr } from "@maple-dev/clickhouse-builder/expr"
import * as CH from "@maple-dev/clickhouse-builder/expr"
import * as T from "@maple-dev/clickhouse-builder/types"
import { compile } from "@maple-dev/clickhouse-builder/sql"
import { AI_SESSION_SPANS_MAX_SPANS } from "@maple/domain/http"

/**
 * Reporters collected per trace. The detail page reads at most this many spans
 * of a session (`AI_SESSION_SPANS_MAX_SPANS`), so past it the two pages already
 * disagree; the cap bounds the quadratic pass in {@link deepestReporterSum} at
 * a few million comparisons for a pathological trace rather than unbounded.
 */
export const MAX_USAGE_REPORTERS_PER_TRACE = AI_SESSION_SPANS_MAX_SPANS

/**
 * One trace's usage reporters — `(SpanId, ParentSpanId, tokens, cost)` per
 * index row that reported usage — for the deepest-reporter sum one level up,
 * which needs the whole trace's reporters in hand at once. A span whose usage
 * parses to zero throughout is not a reporter, the same as `spanTokenBuckets`
 * returning a total of 0: a wrapper stamping empty usage must not be charged
 * as a reporter whose children then owe it their tokens.
 *
 * Raw SQL because the cap is a parameter of the aggregate
 * (`groupArrayIf(N)(…)`), a shape the builder's function-call helper does not
 * render.
 */
export function usageReportersExpr($: {
	readonly SpanId: Expr<string>
	readonly ParentSpanId: Expr<string>
	readonly Tokens: Expr<number>
	readonly Cost: Expr<number>
}): Expr<unknown> {
	const reporter = CH.compileFnCall<unknown>("tuple", $.SpanId, $.ParentSpanId, $.Tokens, $.Cost)
	const reports = $.Tokens.gt(0).or($.Cost.gt(0))
	return CH.untypedExpr(
		`groupArrayIf(${MAX_USAGE_REPORTERS_PER_TRACE})(${compile(reporter.toFragment())}, ${compile(
			reports.toFragment(),
		)})`,
	)
}

/**
 * The session's tokens (`element` 3) or cost (`element` 4), summed over the
 * reporters of each of its traces with what a reporting CHILD already reported
 * taken off its parent. The parent keeps only its excess over its children's
 * sum — zero for a clean roll-up, the missing call's share when one child
 * reported none.
 *
 * `reporters` is the column {@link usageReportersExpr} was selected as, named
 * in raw SQL because the builder has no lambda syntax. `0.` keeps the whole
 * expression Float64.
 */
export function deepestReporterSum(reporters: string, element: 3 | 4): Expr<number> {
	const own = `r.${element}`
	const child = `c.${element}`
	return CH.rawExpr(
		`sum(arraySum(r -> greatest(0., ${own} - arraySum(c -> if(c.2 = r.1, ${child}, 0.), ${reporters})), ${reporters}))`,
		T.float64,
	)
}

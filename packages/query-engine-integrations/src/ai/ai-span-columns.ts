// The session's usage and model calls, counted the way the detail page counts
// them.
//
// `ai_trace_index` carries every GenAI span's tokens and cost (migration
// 0026, `@maple/domain/tinybird/gen-ai-columns`) and, since 0027, the
// provider's response id. Three things would otherwise inflate a session:
//
// - A wrapper's roll-up: several frameworks stamp `gen_ai.usage.*` on the
//   model span AND sum it onto the agent span that wraps it.
//   `countableUsageSpans` in `apps/web/src/lib/agent-sessions/session-summary.ts`
//   charges each reporter to its nearest reporting ancestor and keeps only the
//   excess; {@link sessionUsageSum} is that rule in SQL, one level deep, which
//   is the shape every roll-up in production has.
// - A sub-step of a call: a gateway records its provider attempts as model
//   spans under the model span (OpenRouter's `provider attempt N`), and an SDK
//   wraps `doGenerate` in `generateText`. A model span that reports no usage
//   while its parent does, or whose reported usage its children already
//   account for, is the same call seen again, not another call —
//   {@link sessionLlmCalls}.
// - A second observation: a gateway that forwards its own trace of the call
//   (OpenRouter Broadcast, Helicone, …) lands it in the same session as a
//   separate trace, so the parent/child netting cannot see it. The provider's
//   response id is the one fact both observations carry, so reporters sharing
//   one are the same call: its usage is the larger of the two claims (a
//   gateway prices a call the app's SDK could not), and it is one call.
//   Reporters without an id are counted as they are — the page does not
//   guess.

import type { Expr } from "@maple-dev/clickhouse-builder/expr"
import * as CH from "@maple-dev/clickhouse-builder/expr"
import * as T from "@maple-dev/clickhouse-builder/types"
import { compile } from "@maple-dev/clickhouse-builder/sql"
import { AI_SESSION_SPANS_MAX_SPANS } from "@maple/domain/http"

/**
 * Reporters collected per trace. The detail page reads at most this many spans
 * of a session (`AI_SESSION_SPANS_MAX_SPANS`), so past it the two pages already
 * disagree; the cap bounds the quadratic passes below at a few million
 * comparisons for a pathological trace rather than unbounded.
 */
export const MAX_USAGE_REPORTERS_PER_TRACE = AI_SESSION_SPANS_MAX_SPANS

/**
 * One trace's reporters — `(SpanId, ParentSpanId, tokens, cost, responseId,
 * isLlmCall)` per index row that reported usage or is a model call — for the
 * session-level sums, which need every trace's reporters in hand at once. A
 * span whose usage parses to zero throughout and is not a model call is not a
 * reporter, the same as `spanTokenBuckets` returning a total of 0: a wrapper
 * stamping empty usage must not be charged as a reporter whose children then
 * owe it their tokens.
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
	readonly ResponseId: Expr<string>
	readonly IsLlmCall: Expr<number>
}): Expr<unknown> {
	const reporter = CH.compileFnCall<unknown>(
		"tuple",
		$.SpanId,
		$.ParentSpanId,
		$.Tokens,
		$.Cost,
		$.ResponseId,
		$.IsLlmCall,
	)
	const reports = $.Tokens.gt(0).or($.Cost.gt(0)).or($.IsLlmCall.eq(1))
	return CH.untypedExpr(
		`groupArrayIf(${MAX_USAGE_REPORTERS_PER_TRACE})(${compile(reporter.toFragment())}, ${compile(
			reports.toFragment(),
		)})`,
	)
}

/** Every reporter of the session: the per-trace arrays, flattened at the
 *  session level. Span ids are unique across traces, so the parent lookups
 *  below cannot cross into another trace. */
const sessionReporters = (reporters: string): string => `arrayFlatten(groupArray(${reporters}))`

/** A reporter's own claim for `element` (3 tokens, 4 cost) less what its
 *  reporting children already claimed — zero for a clean roll-up. */
const netted = (all: string, element: 3 | 4, reporter = "r"): string =>
	`greatest(0., ${reporter}.${element} - arraySum(c -> if(c.2 = ${reporter}.1, c.${element}, 0.), ${all}))`

/**
 * The session's tokens (`element` 3) or cost (`element` 4): each reporter's
 * netted claim, summed — with reporters sharing a response id collapsed to the
 * largest claim among them.
 *
 * `reporters` is the column {@link usageReportersExpr} was selected as, named
 * in raw SQL because the builder has no lambda syntax. `0.` keeps the whole
 * expression Float64.
 */
export function sessionUsageSum(reporters: string, element: 3 | 4): Expr<number> {
	const all = sessionReporters(reporters)
	// `(responseId, netted claim)` per reporter.
	const claims = `arrayMap(r -> tuple(r.5, ${netted(all, element)}), ${all})`
	const unkeyed = `arraySum(n -> if(n.1 = '', n.2, 0.), ${claims})`
	const keyed = `arraySum(id -> arrayMax(n -> if(n.1 = id, n.2, 0.), ${claims}), arrayDistinct(arrayFilter(id -> id != '', arrayMap(n -> n.1, ${claims}))))`
	return CH.rawExpr(`${unkeyed} + ${keyed}`, T.float64)
}

/**
 * The session's model calls. A model span counts when it is the deepest
 * account of its call — it reported usage its children do not already cover,
 * or it reported none and neither did its parent (a failed call still counts;
 * a gateway's provider attempt under the call that reports does not) — and
 * calls sharing a response id count once.
 */
export function sessionLlmCalls(reporters: string): Expr<number> {
	const all = sessionReporters(reporters)
	const reportsUsage = (reporter: string) => `(${reporter}.3 > 0 OR ${reporter}.4 > 0)`
	const deepest = `if(${reportsUsage("r")}, ${netted(all, 3)} > 0 OR ${netted(all, 4)} > 0, NOT arrayExists(p -> p.1 = r.2 AND ${reportsUsage("p")}, ${all}))`
	// `(responseId, counts)` per reporter.
	const counted = `arrayMap(r -> tuple(r.5, r.6 = 1 AND ${deepest}), ${all})`
	const unkeyed = `arraySum(n -> if(n.2 AND n.1 = '', 1, 0), ${counted})`
	const keyed = `length(arrayDistinct(arrayFilter(id -> id != '', arrayMap(n -> if(n.2, n.1, ''), ${counted}))))`
	return CH.rawExpr(`toFloat64(${unkeyed} + ${keyed})`, T.float64)
}

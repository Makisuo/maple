/**
 * The `metric` and `group_by` tokens `query_data` accepts, per `source` × `kind`.
 *
 * These cannot be `Schema.Literals` on the MCP input struct, because the valid set
 * depends on two OTHER parameters — `source=metrics, kind=timeseries` accepts
 * `rate`, `source=metrics, kind=breakdown` does not. So the tool takes free-form
 * strings and the real narrowing happens downstream in `QuerySpec`.
 *
 * That left agents guessing: every `query_data` failure in production was a valid-
 * looking token rejected by a combination that does not accept it, reported as a
 * bare `SchemaError` that never named the alternatives. This table is what turns
 * those into an actionable message.
 *
 * `query-spec-tokens.test.ts` asserts every entry against the domain schemas by
 * decoding, so this table cannot drift from `@maple/domain/query-engine`.
 */

export type QuerySpecSource = "traces" | "logs" | "metrics"
export type QuerySpecKind = "timeseries" | "breakdown"

interface TokenSet {
	readonly metrics: ReadonlyArray<string>
	readonly groupBys: ReadonlyArray<string>
}

const TOKENS: Record<`${QuerySpecSource}:${QuerySpecKind}`, TokenSet> = {
	"traces:timeseries": {
		metrics: ["count", "avg_duration", "p50_duration", "p95_duration", "p99_duration", "error_rate", "apdex"],
		groupBys: ["service", "span_name", "status_code", "http_method", "attribute", "none"],
	},
	"traces:breakdown": {
		metrics: ["count", "avg_duration", "p50_duration", "p95_duration", "p99_duration", "error_rate", "apdex"],
		groupBys: ["service", "span_name", "status_code", "http_method", "attribute"],
	},
	"logs:timeseries": {
		metrics: ["count"],
		groupBys: ["service", "severity", "none"],
	},
	"logs:breakdown": {
		metrics: ["count"],
		groupBys: ["service", "severity"],
	},
	// Deliberately narrower than the timeseries set: no min/max/rate/increase.
	// This asymmetry is the single most common query_data failure in production.
	"metrics:breakdown": {
		metrics: ["avg", "sum", "count"],
		groupBys: ["service", "attribute", "resource_attribute"],
	},
	"metrics:timeseries": {
		metrics: ["avg", "sum", "min", "max", "count", "rate", "increase"],
		groupBys: ["service", "attribute", "resource_attribute", "none"],
	},
}

export const tokensFor = (source: QuerySpecSource, kind: QuerySpecKind): TokenSet =>
	TOKENS[`${source}:${kind}`]

const quote = (values: ReadonlyArray<string>): string => values.map((v) => `"${v}"`).join(", ")

/**
 * An actionable replacement for a raw `SchemaError`, naming the tokens valid for
 * the source/kind the agent actually chose and calling out the narrowing when the
 * value would have been accepted by the other `kind`.
 */
export const describeInvalidQuerySpec = (params: {
	readonly source: QuerySpecSource
	readonly kind: QuerySpecKind
	readonly metric: string | undefined
	readonly groupBy: string | undefined
}): { readonly message: string; readonly example: string } | undefined => {
	const { source, kind, metric, groupBy } = params
	const valid = tokensFor(source, kind)
	const otherKind: QuerySpecKind = kind === "timeseries" ? "breakdown" : "timeseries"

	if (metric !== undefined && !valid.metrics.includes(metric)) {
		const acceptedElsewhere = tokensFor(source, otherKind).metrics.includes(metric)
		const note = acceptedElsewhere
			? ` It is valid for kind="${otherKind}" but not for kind="${kind}".`
			: ""
		return {
			message: `Invalid metric "${metric}" for source="${source}" kind="${kind}".${note} Valid metrics: ${quote(valid.metrics)}.`,
			example: `source="${source}" kind="${kind}" metric="${valid.metrics[0]}"`,
		}
	}

	if (groupBy !== undefined && !valid.groupBys.includes(groupBy)) {
		const acceptedElsewhere = tokensFor(source, otherKind).groupBys.includes(groupBy)
		const note = acceptedElsewhere
			? ` It is valid for kind="${otherKind}" but not for kind="${kind}".`
			: ""
		return {
			message: `Invalid group_by "${groupBy}" for source="${source}" kind="${kind}".${note} Valid group_by values: ${quote(valid.groupBys)}.`,
			example: `source="${source}" kind="${kind}" group_by="${valid.groupBys[0]}"`,
		}
	}

	return undefined
}

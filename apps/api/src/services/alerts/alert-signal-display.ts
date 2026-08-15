/**
 * How an alert rule's measured quantity is named and unit-formatted in outbound
 * notifications.
 *
 * `signalType` alone is NOT that name. It is the rule's *query kind*, and two of
 * its members — `builder_query` and `raw_query` — say only "this rule runs a
 * query", not what the query measures. Printing the enum verbatim produced Slack
 * messages reading "builder_query is 1041923". The measured quantity for those
 * two lives in the rule's `queryBuilderDraft` / `rawQueryReducer`, which is why
 * this resolves from the rule rather than from the enum.
 *
 * The unit travels with the label because the two are decided by the same facts:
 * a traces `p95_duration` query is milliseconds, `error_rate` is a ratio, and a
 * metrics query is an unknown unit that must render as a plain number. Deriving
 * them separately is how the observed value and its threshold drift apart.
 */
import type { AlertSignalType, QueryBuilderQueryDraftPayload } from "@maple/domain/http"
import { AGGREGATIONS_BY_SOURCE } from "@maple/query-engine/query-builder"

export type SignalUnit = "ratio" | "ms" | "rpm" | "apdex" | "count" | "plain"

export interface SignalDisplay {
	/** Human-readable name of the measured quantity, e.g. `sum(db.query.duration)`. */
	readonly label: string
	readonly unit: SignalUnit
}

export interface SignalDisplayInput {
	readonly signalType: AlertSignalType | string
	readonly queryBuilderDraft?: QueryBuilderQueryDraftPayload | null
	/**
	 * Widened to `string` so the undecoded `alert_rules.reducer` column can be
	 * passed straight through: this only compares it, and a delivery must not
	 * fail on an unrecognized reducer spelling.
	 */
	readonly rawQueryReducer?: string | null
}

const PRESET_SIGNALS: Record<string, SignalDisplay> = {
	error_rate: { label: "Error Rate", unit: "ratio" },
	p95_latency: { label: "P95 Latency", unit: "ms" },
	p99_latency: { label: "P99 Latency", unit: "ms" },
	apdex: { label: "Apdex", unit: "apdex" },
	throughput: { label: "Throughput", unit: "rpm" },
} satisfies Record<string, SignalDisplay>

/**
 * `p95_duration` → `p95(duration)`. Reuses the query builder's own option labels
 * so the notification names the aggregation exactly as the rule author picked it
 * in the UI.
 */
const TRACES_AGGREGATION_LABELS = new Map(
	AGGREGATIONS_BY_SOURCE.traces.map((option) => [option.value, option.label]),
)

const tracesAggregationUnit = (aggregation: string): SignalUnit => {
	if (aggregation.endsWith("_duration")) return "ms"
	if (aggregation === "error_rate") return "ratio"
	if (aggregation === "count") return "count"
	return "plain"
}

/** `builder_query` → `Builder query`, so an unmapped enum never leaks verbatim. */
const humanize = (value: string): string => {
	const words = value.replace(/[_-]+/g, " ").trim()
	if (words.length === 0) return "Signal"
	return words.charAt(0).toUpperCase() + words.slice(1)
}

const call = (fn: string, arg: string | undefined): string =>
	arg != null && arg.trim().length > 0 ? `${fn}(${arg.trim()})` : fn

const builderQueryDisplay = (draft: QueryBuilderQueryDraftPayload): SignalDisplay => {
	const aggregation = draft.aggregation.trim()
	const named = (label: string, unit: SignalUnit): SignalDisplay =>
		label.length > 0 ? { label, unit } : { label: draft.name.trim() || "Query", unit }

	if (draft.dataSource === "metrics") {
		// The metric's unit is not carried on the draft, so the value stays plain.
		return named(call(aggregation, draft.metricName), "plain")
	}
	if (draft.dataSource === "logs") {
		return named(aggregation === "count" ? "Log count" : aggregation, "count")
	}
	// Traces. A non-empty `valueField` switches the query into numeric-attribute
	// aggregation, so the attribute — not "duration" — is what is being measured.
	if (draft.valueField != null && draft.valueField.trim().length > 0) {
		return named(call(aggregation, draft.valueField), "plain")
	}
	return named(
		TRACES_AGGREGATION_LABELS.get(aggregation) ?? aggregation,
		tracesAggregationUnit(aggregation),
	)
}

const rawQueryDisplay = (reducer: string | null | undefined): SignalDisplay => ({
	// `identity` means "the bucket value as-is" — naming it would add noise.
	label: reducer != null && reducer !== "identity" ? `SQL result (${reducer})` : "SQL result",
	unit: "plain",
})

export const resolveSignalDisplay = (input: SignalDisplayInput): SignalDisplay => {
	const preset = PRESET_SIGNALS[input.signalType]
	if (preset) return preset
	if (input.signalType === "builder_query" && input.queryBuilderDraft != null) {
		return builderQueryDisplay(input.queryBuilderDraft)
	}
	if (input.signalType === "raw_query") return rawQueryDisplay(input.rawQueryReducer)
	// A query-driven rule whose definition could not be loaded (deleted rule row),
	// or a signal type added to the domain without an entry here.
	return { label: humanize(input.signalType), unit: "plain" }
}

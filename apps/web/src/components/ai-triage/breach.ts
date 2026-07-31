import type { AlertComparator, AlertSignalType } from "@maple/domain/http"
import { formatSignalValue } from "@/lib/alerts/form-utils"

/**
 * Runtime-narrow a string (e.g. from the base64 alert-link context, where the
 * literal type is lost) back to a typed `AlertSignalType`. The case-literal
 * switch narrows without a cast.
 */
export function toAlertSignalType(value: string): AlertSignalType | null {
	switch (value) {
		case "error_rate":
		case "p95_latency":
		case "p99_latency":
		case "apdex":
		case "throughput":
		case "builder_query":
		case "raw_query":
			return value
		default:
			return null
	}
}

/** Runtime-narrow a string back to a typed `AlertComparator` (see `toAlertSignalType`). */
export function toAlertComparator(value: string): AlertComparator | null {
	switch (value) {
		case "gt":
		case "gte":
		case "lt":
		case "lte":
		case "eq":
		case "neq":
		case "between":
		case "not_between":
			return value
		default:
			return null
	}
}

export interface Breach {
	/** Observed value, formatted for the signal (e.g. `6.25%`, `1.2s`). */
	observed: string
	/** Threshold the rule compares against, formatted for the signal. */
	threshold: string
	/** Signed magnitude past the threshold (e.g. `+25% over`), or null when it can't be derived. */
	delta: string | null
	/** True when the observed value sits on the breaching side of the threshold. */
	exceedsThreshold: boolean
}

/**
 * Frame the incident's observed value against its threshold as a scannable
 * "breach" stat — the honest at-a-glance "score" for the report rail.
 *
 * The signed delta is only meaningful for one-sided comparators; range/equality
 * comparators get `delta: null` and the caller shows the bare observed-vs-threshold.
 */
export function formatBreach(
	signalType: AlertSignalType,
	comparator: AlertComparator,
	value: number | null,
	threshold: number,
): Breach {
	const observed = formatSignalValue(signalType, value)
	const thresholdLabel = formatSignalValue(signalType, threshold)

	if (value === null || threshold === 0) {
		return { observed, threshold: thresholdLabel, delta: null, exceedsThreshold: false }
	}

	const magnitude = Math.abs(value - threshold) / Math.abs(threshold)
	const pct = Math.round(magnitude * 100)

	switch (comparator) {
		case "gt":
		case "gte": {
			const over = value >= threshold
			return {
				observed,
				threshold: thresholdLabel,
				delta: `${over ? "+" : "−"}${pct}% ${over ? "over" : "under"}`,
				exceedsThreshold: over,
			}
		}
		case "lt":
		case "lte": {
			const under = value <= threshold
			return {
				observed,
				threshold: thresholdLabel,
				delta: `${under ? "−" : "+"}${pct}% ${under ? "under" : "over"}`,
				exceedsThreshold: under,
			}
		}
		// Range/equality comparators: the bare observed-vs-threshold reads clearer than a signed %.
		default:
			return { observed, threshold: thresholdLabel, delta: null, exceedsThreshold: true }
	}
}

/**
 * Narrow an alert's stringly-typed signal/comparator (from the base64 link context)
 * and format its breach in one pass — the report subject and the chat context both
 * need this trio, so deriving it once keeps them in sync.
 */
export function narrowAlertSignal(alert: {
	signalType: string
	comparator: string
	value: number | null
	threshold: number
}): { signalType: AlertSignalType | null; comparator: AlertComparator | null; breach: Breach | null } {
	const signalType = toAlertSignalType(alert.signalType)
	const comparator = toAlertComparator(alert.comparator)
	const breach =
		signalType && comparator ? formatBreach(signalType, comparator, alert.value, alert.threshold) : null
	return { signalType, comparator, breach }
}

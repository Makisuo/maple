import {
	UNGROUPED_GROUP_KEY,
	type AlertComparator,
	type AlertEventType,
	type AlertSeverity,
	type AlertSignalType,
} from "@maple/domain/http"
import { Match, Option } from "effect"
import { resolveSignalDisplay, type SignalDisplay } from "./alert-signal-display"
import type { NotificationTemplateConfig } from "./alert-templating/renderer"

export interface TemplateRenderContext {
	readonly ruleId: string
	readonly ruleName: string
	readonly eventType: AlertEventType
	readonly severity: AlertSeverity
	readonly signalType: AlertSignalType
	/**
	 * How this rule's measured quantity is named and unit-formatted. Optional
	 * because the escalation/error-notification paths dispatch without an alert
	 * rule; those fall back to what `signalType` alone can say.
	 */
	readonly signalDisplay?: SignalDisplay | null
	readonly comparator: AlertComparator
	readonly threshold: number
	readonly thresholdUpper: number | null
	readonly value: number | null
	readonly sampleCount: number | null
	readonly groupKey: string | null
	readonly windowMinutes: number
	readonly incidentId: string | null
	readonly incidentStatus: string
	readonly dedupeKey: string
	readonly template?: NotificationTemplateConfig | null
	readonly sentAtMs?: number
}

const round = (value: number, decimals = 2): string => {
	const factor = 10 ** decimals
	return (Math.round(value * factor) / factor).toString()
}

/**
 * The group key as a human should see it, or `null` when the rule is not
 * grouped.
 *
 * An ungrouped rule stores `UNGROUPED_GROUP_KEY` (`"__total__"`) as its group
 * key — a storage sentinel meaning "the whole rule", not a group anyone named.
 * It was reaching notifications verbatim, so Slack rendered a `Group` field
 * reading `__total__`. `issue-hub.ts` and the web alert-source card already
 * guard against it; the notification path did not.
 */
export const displayGroupKey = (groupKey: string | null): string | null =>
	groupKey == null || groupKey === UNGROUPED_GROUP_KEY ? null : groupKey

/** Clamp to a provider's field limit, marking the cut with an ellipsis. */
export const truncate = (value: string, max: number): string =>
	value.length > max ? `${value.slice(0, max - 1)}…` : value

/** Thousands separators — an unpunctuated `1041923` is unreadable at a glance. */
const grouped = (value: number): string =>
	new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value)

/** The fields every signal-aware formatter needs. */
type SignalContext = Pick<TemplateRenderContext, "signalType" | "signalDisplay">

export const signalDisplayOf = (context: SignalContext): SignalDisplay =>
	context.signalDisplay ?? resolveSignalDisplay({ signalType: context.signalType })

export const formatComparator = (
	value: AlertComparator,
	threshold?: number,
	thresholdUpper?: number | null,
): string => {
	const operator = Match.value(value).pipe(
		Match.when("gt", () => ">"),
		Match.when("gte", () => ">="),
		Match.when("lt", () => "<"),
		Match.when("lte", () => "<="),
		Match.when("eq", () => "="),
		Match.when("neq", () => "!="),
		Match.when("between", () => "between"),
		Match.when("not_between", () => "not between"),
		Match.exhaustive,
	)
	if (threshold == null) return operator
	if (value === "between" || value === "not_between") {
		const upper = thresholdUpper ?? threshold
		return `${operator} ${threshold} and ${upper}`
	}
	return `${operator} ${threshold}`
}

export const formatSignalLabel = (context: SignalContext): string => signalDisplayOf(context).label

export const eventTypeEmoji = (type: string) => {
	const map: Record<string, string> = {
		trigger: "\u{1F6A8}",
		resolve: "\u2705",
		renotify: "\u{1F514}",
		test: "\u{1F9EA}",
	}
	return map[type] ?? "\u{1F4E2}"
}

export const formatEventTypeLabel = (type: string) => {
	const map: Record<string, string> = {
		trigger: "Triggered",
		resolve: "Resolved",
		renotify: "Re-notification",
		test: "Test",
	}
	return map[type] ?? type
}

/**
 * Formats by the signal's UNIT, not by its query kind — a `builder_query` over
 * `p95(duration)` is milliseconds just as much as the `p95_latency` preset is.
 */
export const formatSignalMetric = (value: number | null, display: SignalDisplay): string =>
	Option.match(Option.fromNullishOr(value), {
		onNone: () => "n/a",
		onSome: (metric) =>
			Match.value(display.unit).pipe(
				Match.when("ratio", () => `${round(metric * 100, 1)}%`),
				Match.when("ms", () => `${grouped(metric)}ms`),
				Match.when("apdex", () => `${round(metric, 3)}`),
				Match.when("rpm", () => `${grouped(metric)} rpm`),
				Match.whenOr("count", "plain", () => grouped(metric)),
				Match.exhaustive,
			),
	})

export const formatWindow = (minutes: number): string => {
	if (minutes < 60) return `${minutes}m`
	const hours = minutes / 60
	return hours % 1 === 0 ? `${hours}h` : `${minutes}m`
}

export const severityEmoji = (severity: AlertSeverity): string =>
	Match.value(severity).pipe(
		Match.when("critical", () => "\u{1F534}"),
		Match.when("warning", () => "\u{1F7E0}"),
		Match.exhaustive,
	)

export const formatSeverityLabel = (severity: AlertSeverity): string =>
	Match.value(severity).pipe(
		Match.when("critical", () => "Critical"),
		Match.when("warning", () => "Warning"),
		Match.exhaustive,
	)

export const slackAttachmentColor = (eventType: string, severity: string): string => {
	if (eventType === "resolve") return "#2eb67d"
	if (eventType === "test") return "#36c5f0"
	if (severity === "critical") return "#e01e5a"
	return "#ecb22e"
}

export const discordEmbedColor = (eventType: string, severity: string): number => {
	if (eventType === "resolve") return 0x2eb67d
	if (eventType === "test") return 0x36c5f0
	if (severity === "critical") return 0xe01e5a
	return 0xecb22e
}

type ObservedContext = SignalContext &
	Pick<TemplateRenderContext, "value" | "comparator" | "threshold" | "thresholdUpper">
type ThresholdContext = Omit<ObservedContext, "value">

export const formatThresholdSummary = (context: ThresholdContext): string => {
	const display = signalDisplayOf(context)
	return context.comparator === "between" || context.comparator === "not_between"
		? `${formatComparator(context.comparator)} ${formatSignalMetric(context.threshold, display)} and ${formatSignalMetric(context.thresholdUpper ?? context.threshold, display)}`
		: `${formatComparator(context.comparator)} ${formatSignalMetric(context.threshold, display)}`
}

export const formatObservedSummary = (context: ObservedContext): string =>
	`${formatSignalMetric(context.value, signalDisplayOf(context))} ${formatThresholdSummary(context)}`

export const comparatorBreachPhrase = (context: ThresholdContext): string => {
	const display = signalDisplayOf(context)
	const threshold = formatSignalMetric(context.threshold, display)
	const upper = formatSignalMetric(context.thresholdUpper ?? context.threshold, display)
	return Match.value(context.comparator).pipe(
		Match.whenOr("gt", "gte", () => `above the ${threshold} threshold`),
		Match.whenOr("lt", "lte", () => `below the ${threshold} threshold`),
		Match.when("eq", () => `at the ${threshold} threshold`),
		Match.when("neq", () => `away from the ${threshold} target`),
		Match.when("between", () => `inside the ${threshold}–${upper} range`),
		Match.when("not_between", () => `outside the ${threshold}–${upper} range`),
		Match.exhaustive,
	)
}

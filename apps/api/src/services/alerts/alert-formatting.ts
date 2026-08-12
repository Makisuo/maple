import type { AlertComparator, AlertEventType, AlertSeverity, AlertSignalType } from "@maple/domain/http"
import { Match, Option } from "effect"
import type { NotificationTemplateConfig } from "./alert-templating/renderer"

export interface TemplateRenderContext {
	readonly ruleId: string
	readonly ruleName: string
	readonly eventType: AlertEventType
	readonly severity: AlertSeverity
	readonly signalType: AlertSignalType
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

export const formatSignalLabel = (signal: string) => {
	const labels: Record<string, string> = {
		error_rate: "Error Rate",
		p95_latency: "P95 Latency",
		p99_latency: "P99 Latency",
		apdex: "Apdex",
		throughput: "Throughput",
		metric: "Metric",
	}
	return labels[signal] ?? signal
}

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

export const formatSignalMetric = (value: number | null, signalType: string): string =>
	Option.match(Option.fromNullishOr(value), {
		onNone: () => "n/a",
		onSome: (metric) =>
			Match.value(signalType).pipe(
				Match.when("error_rate", () => `${round(metric * 100, 1)}%`),
				Match.whenOr("p95_latency", "p99_latency", () => `${round(metric)}ms`),
				Match.when("apdex", () => `${round(metric, 3)}`),
				Match.when("throughput", () => `${round(metric)} rpm`),
				Match.orElse(() => `${round(metric)}`),
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

type ObservedContext = Pick<
	TemplateRenderContext,
	"value" | "signalType" | "comparator" | "threshold" | "thresholdUpper"
>
type ThresholdContext = Omit<ObservedContext, "value">

export const formatThresholdSummary = (context: ThresholdContext): string =>
	context.comparator === "between" || context.comparator === "not_between"
		? `${formatComparator(context.comparator)} ${formatSignalMetric(context.threshold, context.signalType)} and ${formatSignalMetric(context.thresholdUpper ?? context.threshold, context.signalType)}`
		: `${formatComparator(context.comparator)} ${formatSignalMetric(context.threshold, context.signalType)}`

export const formatObservedSummary = (context: ObservedContext): string =>
	`${formatSignalMetric(context.value, context.signalType)} ${formatThresholdSummary(context)}`

export const comparatorBreachPhrase = (context: ThresholdContext): string => {
	const threshold = formatSignalMetric(context.threshold, context.signalType)
	const upper = formatSignalMetric(context.thresholdUpper ?? context.threshold, context.signalType)
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

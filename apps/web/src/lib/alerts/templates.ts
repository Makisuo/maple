import type { ReactNode } from "react"
import {
	AlertWarningIcon,
	ChartLineIcon,
	CirclePercentageIcon,
	FireIcon,
	PulseIcon,
} from "@/components/icons"
import type { RuleFormState } from "@/lib/alerts/form-utils"

/**
 * Quick-start alert presets shown in the first-touch overlay on /alerts/create.
 *
 * Mirror the 5 templates surfaced by the `create_alert_rule` MCP tool
 * (apps/api/src/mcp/tools/create-alert-rule.ts) so the UI and the agent path
 * cover the same set of common alerts. Both lists draw their constants from
 * `@maple/domain/http`, so the only shared contract is the signal/threshold
 * shape — the data here stays a pure module with no React in the import graph
 * beyond the icon components used for display.
 */
type AlertTemplateId = "high_error_rate" | "slow_p95" | "slow_p99" | "low_apdex" | "throughput_drop"

export interface AlertTemplate {
	id: AlertTemplateId
	title: string
	description: string
	/** One-liner shown under the title in the picker, e.g. `error rate > 5% / 5min`. */
	summary: string
	icon: (props: { size?: number; className?: string }) => ReactNode
	/** Apply the template's defaults on top of the current form draft. */
	apply: (base: RuleFormState) => RuleFormState
}

export const ALERT_TEMPLATES: readonly AlertTemplate[] = [
	{
		id: "high_error_rate",
		title: "High error rate",
		description: "Catch error-rate spikes on root spans before users do.",
		summary: "error rate > 5% / 5min",
		icon: FireIcon,
		apply: (base) => ({
			...base,
			name: base.name || "High error rate",
			signalType: "error_rate",
			comparator: "gt",
			threshold: "5",
			windowMinutes: "5",
			// Group per service unless the draft already carries a service scope or
			// grouping (they are mutually exclusive server-side). Ungrouped, the rule
			// evaluates one org-wide ratio — a small service can fail outright without
			// moving a 5% aggregate. Mirrors the MCP template's default.
			groupBy:
				base.serviceNames.length > 0 || base.groupBy.length > 0 ? base.groupBy : ["service.name"],
		}),
	},
	{
		id: "slow_p95",
		title: "Slow P95 latency",
		description: "Page on tail-latency regressions for root spans.",
		summary: "P95 > 1000ms / 5min",
		icon: ChartLineIcon,
		apply: (base) => ({
			...base,
			name: base.name || "Slow P95 latency",
			signalType: "p95_latency",
			comparator: "gt",
			threshold: "1000",
			windowMinutes: "5",
		}),
	},
	{
		id: "slow_p99",
		title: "Slow P99 latency",
		description: "Bound the very worst request you'll tolerate.",
		summary: "P99 > 2000ms / 5min",
		icon: ChartLineIcon,
		apply: (base) => ({
			...base,
			name: base.name || "Slow P99 latency",
			signalType: "p99_latency",
			comparator: "gt",
			threshold: "2000",
			windowMinutes: "5",
		}),
	},
	{
		id: "low_apdex",
		title: "Low Apdex score",
		description: "User-satisfaction drop measured against a target.",
		summary: "Apdex < 0.8 / 5min (target 500ms)",
		icon: CirclePercentageIcon,
		apply: (base) => ({
			...base,
			name: base.name || "Low Apdex score",
			signalType: "apdex",
			comparator: "lt",
			threshold: "0.8",
			apdexThresholdMs: "500",
			windowMinutes: "5",
		}),
	},
	{
		id: "throughput_drop",
		title: "Throughput drop",
		description: "Wake up when traffic falls off a cliff.",
		summary: "throughput < 100 / 5min",
		icon: PulseIcon,
		apply: (base) => ({
			...base,
			name: base.name || "Throughput drop",
			signalType: "throughput",
			comparator: "lt",
			threshold: "100",
			windowMinutes: "5",
			// The evaluator skips windows whose sample count is below the minimum
			// BEFORE comparing the threshold, and for throughput the sample count IS
			// the signal — the blank form's default of 50 would skip exactly the
			// severe drops (0–49 samples), including a total outage.
			minimumSampleCount: "0",
		}),
	},
] as const

export function applyTemplate(template: AlertTemplate, base: RuleFormState): RuleFormState {
	return template.apply(base)
}

/** Re-exported icon used by the "blank rule" tile in the picker. */
export { AlertWarningIcon as BlankRuleIcon }

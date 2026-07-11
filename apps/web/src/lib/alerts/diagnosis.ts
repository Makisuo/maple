import type {
	AlertCheckDocument,
	AlertDeliveryEventDocument,
	AlertDestinationDocument,
	AlertIncidentDocument,
	AlertRuleDocument,
} from "@maple/domain/http"
import type { AlertRuleStateRow } from "@/lib/collections/alerts"
import { comparatorLabels, formatSignalValue } from "@/lib/alerts/form-utils"
import { staleThresholdMs } from "@/lib/alerts/rule-status"

export type DiagnosisStageStatus = "pass" | "fail" | "warn" | "unknown"

export interface DiagnosisStage {
	readonly id:
		| "enabled"
		| "evaluated"
		| "query"
		| "data"
		| "threshold"
		| "incident"
		| "notification"
	readonly label: string
	readonly status: DiagnosisStageStatus
	/** One human sentence — the header verdict uses the first failing stage's summary. */
	readonly summary: string
	/** Supporting detail lines, shown when the stage is expanded. */
	readonly evidence: ReadonlyArray<string>
	readonly action?: { readonly label: string; readonly kind: "enable" | "edit" | "destinations" }
}

export interface DiagnosisInput {
	readonly rule: AlertRuleDocument
	/** Live per-group states; may be empty on non-Electric builds. */
	readonly states: ReadonlyArray<AlertRuleStateRow>
	/** Recorded checks in the page window, newest first (the listRuleChecks order). */
	readonly checks: ReadonlyArray<AlertCheckDocument>
	readonly openIncidents: ReadonlyArray<AlertIncidentDocument>
	/** All org destinations — resolved against rule.destinationIds internally. */
	readonly destinations: ReadonlyArray<AlertDestinationDocument>
	/** Delivery events pre-filtered to this rule, newest first. */
	readonly deliveryEvents: ReadonlyArray<AlertDeliveryEventDocument>
	readonly now: number
	/** Grouped rules: diagnose one group; defaults to the worst one. */
	readonly selectedGroupKey?: string
}

const relative = (now: number, thenMs: number): string => {
	const diff = Math.max(0, now - thenMs)
	const mins = Math.round(diff / 60_000)
	if (mins < 1) return "just now"
	if (mins < 60) return `${mins}m ago`
	const hours = Math.floor(mins / 60)
	if (hours < 24) return `${hours}h ago`
	return `${Math.floor(hours / 24)}d ago`
}

const parseMs = (value: string | null | undefined): number | null => {
	if (value == null) return null
	const ms = new Date(value).getTime()
	return Number.isFinite(ms) ? ms : null
}

/**
 * Walk the evaluation pipeline and report where it breaks — the direct answer
 * to "why isn't this alert firing / why is it failing". Stages are ordered the
 * way the scheduler works: enabled → evaluated → query → data → threshold →
 * incident → notification. Pure so it can be unit-tested exhaustively.
 */
export function buildDiagnosis(input: DiagnosisInput): DiagnosisStage[] {
	const { rule, checks, openIncidents, destinations, deliveryEvents, now } = input

	// Scope per-group evidence to the selected group (or the whole set when
	// ungrouped / unselected).
	const states =
		input.selectedGroupKey != null
			? input.states.filter((s) => s.group_key === input.selectedGroupKey)
			: input.states
	const groupChecks =
		input.selectedGroupKey != null
			? checks.filter((c) => c.groupKey === input.selectedGroupKey || c.status === "error")
			: checks

	const stages: DiagnosisStage[] = []

	/* 1 — Enabled */
	stages.push(
		rule.enabled
			? { id: "enabled", label: "Rule enabled", status: "pass", summary: "Rule is enabled", evidence: [] }
			: {
					id: "enabled",
					label: "Rule enabled",
					status: "fail",
					summary: "Rule is disabled — it will never evaluate or fire",
					evidence: [],
					action: { label: "Enable rule", kind: "enable" },
				},
	)

	/* 2 — Evaluated recently */
	const stateEvaluatedAt = states
		.map((s) => parseMs(s.last_evaluated_at))
		.filter((ms): ms is number => ms != null)
		.reduce<number | null>((max, ms) => (max == null || ms > max ? ms : max), null)
	const evaluatedAt = stateEvaluatedAt ?? parseMs(rule.lastEvaluatedAt)
	const scheduledAt = parseMs(rule.lastScheduledAt)
	if (evaluatedAt == null && scheduledAt == null) {
		stages.push({
			id: "evaluated",
			label: "Evaluated recently",
			status: rule.enabled ? "fail" : "unknown",
			summary: "Never evaluated — the scheduler has not picked this rule up yet",
			evidence: ["New rules are evaluated within about a minute of being enabled."],
		})
	} else {
		const referenceMs = evaluatedAt ?? scheduledAt!
		const stale = now - referenceMs > staleThresholdMs(rule)
		stages.push({
			id: "evaluated",
			label: "Evaluated recently",
			status: stale ? "warn" : "pass",
			summary: stale
				? `Last evaluated ${relative(now, referenceMs)} — expected roughly every minute`
				: `Last evaluated ${relative(now, referenceMs)}`,
			evidence: [
				evaluatedAt != null ? `Last evaluation: ${new Date(evaluatedAt).toLocaleString()}` : null,
				scheduledAt != null ? `Last scheduled: ${new Date(scheduledAt).toLocaleString()}` : null,
			].filter((line): line is string => line != null),
		})
	}

	/* 3 — Query succeeded */
	const stateError = states.find((s) => s.last_error != null)?.last_error ?? null
	const errorMessage = stateError ?? rule.lastEvaluationError
	const errorChecks = checks.filter((c) => c.status === "error")
	if (errorMessage != null) {
		stages.push({
			id: "query",
			label: "Query succeeded",
			status: "fail",
			summary: "The rule's query is failing",
			evidence: [
				errorMessage,
				...(errorChecks[0]?.errorCategory != null ? [`Category: ${errorChecks[0].errorCategory}`] : []),
				...(evaluatedAt != null ? [`Last attempt ${relative(now, evaluatedAt)}`] : []),
			],
			action: { label: "Edit rule", kind: "edit" },
		})
	} else if (errorChecks.length > 0) {
		stages.push({
			id: "query",
			label: "Query succeeded",
			status: "warn",
			summary: `${errorChecks.length} failed evaluation${errorChecks.length === 1 ? "" : "s"} in this window (recovered since)`,
			evidence: errorChecks[0]?.errorMessage != null ? [errorChecks[0].errorMessage] : [],
		})
	} else {
		stages.push({
			id: "query",
			label: "Query succeeded",
			status: evaluatedAt != null ? "pass" : "unknown",
			summary: evaluatedAt != null ? "Query is running cleanly" : "No evaluations yet",
			evidence: [],
		})
	}

	/* 4 — Data found */
	const latestState = states[0] ?? null
	const latestCheck = groupChecks.find((c) => c.status !== "error") ?? null
	const sampleCount = latestState?.last_sample_count ?? latestCheck?.sampleCount ?? null
	const skippedChecks = groupChecks.filter((c) => c.status === "skipped").length
	const observableChecks = groupChecks.filter((c) => c.status !== "error").length
	const noDataExplainer =
		rule.noDataBehavior === "zero"
			? "No-data windows are treated as 0 (they still evaluate)."
			: "No-data windows are skipped (they never breach)."
	if (observableChecks > 0 && skippedChecks === observableChecks) {
		stages.push({
			id: "data",
			label: "Data found",
			status: "fail",
			summary: "Every check in this window was skipped — no matching data",
			evidence: [
				`${skippedChecks} of ${observableChecks} checks skipped`,
				rule.minimumSampleCount > 0
					? `Minimum sample count: ${rule.minimumSampleCount} — windows below it are skipped`
					: null,
				noDataExplainer,
				"Check the rule's service scope and filters against what is actually ingesting.",
			].filter((line): line is string => line != null),
			action: { label: "Edit rule", kind: "edit" },
		})
	} else {
		const latestSkipped =
			latestState?.last_status === "skipped" || (latestState == null && latestCheck?.status === "skipped")
		stages.push({
			id: "data",
			label: "Data found",
			status: latestSkipped ? "warn" : sampleCount != null ? "pass" : "unknown",
			summary: latestSkipped
				? "The most recent check was skipped (not enough data)"
				: sampleCount != null
					? `${sampleCount} samples in the last window`
					: "No sample data yet",
			evidence: [
				skippedChecks > 0 ? `${skippedChecks} skipped checks in this window` : null,
				rule.minimumSampleCount > 0 ? `Minimum sample count: ${rule.minimumSampleCount}` : null,
				noDataExplainer,
			].filter((line): line is string => line != null),
		})
	}

	/* 5 — Threshold compared */
	const lastValue = latestState?.last_value ?? latestCheck?.observedValue ?? null
	const thresholdText = `${comparatorLabels[rule.comparator]} ${formatSignalValue(rule.signalType, rule.threshold)}${rule.thresholdUpper != null ? ` and ${formatSignalValue(rule.signalType, rule.thresholdUpper)}` : ""}`
	const consecutiveBreaches = latestState?.consecutive_breaches ?? latestCheck?.consecutiveBreaches ?? 0
	const breaching =
		latestState?.last_status === "breached" || (latestState == null && latestCheck?.status === "breached")
	if (lastValue == null) {
		stages.push({
			id: "threshold",
			label: "Threshold compared",
			status: "unknown",
			summary: "No observed value yet",
			evidence: [`Fires when the value is ${thresholdText}`],
		})
	} else if (breaching) {
		const needed = rule.consecutiveBreachesRequired
		stages.push({
			id: "threshold",
			label: "Threshold compared",
			status: "warn",
			summary:
				consecutiveBreaches >= needed
					? `Breaching — ${formatSignalValue(rule.signalType, lastValue)} is ${thresholdText}`
					: `Breaching — ${Math.min(consecutiveBreaches, needed)} of ${needed} consecutive breaches needed to fire`,
			evidence: [
				`Last value: ${formatSignalValue(rule.signalType, lastValue)} (fires when ${thresholdText})`,
				`Consecutive breaches: ${consecutiveBreaches} / ${needed}`,
			],
		})
	} else {
		stages.push({
			id: "threshold",
			label: "Threshold compared",
			status: "pass",
			summary: `Within threshold — last value ${formatSignalValue(rule.signalType, lastValue)}`,
			evidence: [`Fires when the value is ${thresholdText} for ${rule.consecutiveBreachesRequired} consecutive checks`],
		})
	}

	/* 6 — Incident opened */
	const groupIncidents =
		input.selectedGroupKey != null
			? openIncidents.filter((i) => i.groupKey === input.selectedGroupKey || i.groupKey == null)
			: openIncidents
	if (groupIncidents.length > 0) {
		const first = groupIncidents[0]!
		stages.push({
			id: "incident",
			label: "Incident opened",
			status: "warn",
			summary:
				groupIncidents.length === 1
					? `1 open incident since ${relative(now, new Date(first.firstTriggeredAt).getTime())}`
					: `${groupIncidents.length} open incidents`,
			evidence: groupIncidents
				.slice(0, 5)
				.map(
					(i) =>
						`${i.groupKey ?? "all"} — opened ${relative(now, new Date(i.firstTriggeredAt).getTime())}`,
				),
		})
	} else {
		stages.push({
			id: "incident",
			label: "Incident opened",
			status: "pass",
			summary: `No open incident — the condition has not been met ${rule.consecutiveBreachesRequired} consecutive times`,
			evidence: [],
		})
	}

	/* 7 — Notification delivered */
	if (rule.destinationIds.length === 0) {
		stages.push({
			id: "notification",
			label: "Notification delivered",
			status: rule.enabled ? "fail" : "warn",
			summary: "No destinations — this rule fires into the void",
			evidence: ["Add a Slack/PagerDuty/webhook destination so incidents actually reach someone."],
			action: { label: "Configure destinations", kind: "destinations" },
		})
	} else {
		const destinationById = new Map(destinations.map((d) => [d.id as string, d]))
		const evidence: string[] = []
		let failures = 0
		let deliveries = 0
		for (const destinationId of rule.destinationIds) {
			const destination = destinationById.get(destinationId)
			const name = destination?.name ?? "Unknown destination"
			const latest = deliveryEvents.find((e) => e.destinationId === destinationId) ?? null
			if (destination != null && !destination.enabled) {
				evidence.push(`${name}: destination disabled`)
				failures += 1
			} else if (latest == null) {
				evidence.push(`${name}: no deliveries yet`)
			} else if (latest.status === "failed") {
				failures += 1
				evidence.push(
					`${name}: last delivery failed${latest.responseCode != null ? ` (HTTP ${latest.responseCode})` : ""}${latest.errorMessage != null ? ` — ${latest.errorMessage}` : ""}`,
				)
			} else if (latest.status === "success") {
				deliveries += 1
				evidence.push(
					`${name}: delivered ${latest.attemptedAt != null ? relative(now, new Date(latest.attemptedAt).getTime()) : ""}`.trim(),
				)
			} else {
				evidence.push(`${name}: ${latest.status}`)
			}
		}
		stages.push({
			id: "notification",
			label: "Notification delivered",
			status: failures > 0 ? "fail" : deliveries > 0 ? "pass" : "unknown",
			summary:
				failures > 0
					? `${failures} destination${failures === 1 ? " is" : "s are"} failing`
					: deliveries > 0
						? "Notifications are delivering"
						: "No notifications sent yet",
			evidence,
			...(failures > 0
				? { action: { label: "Review destinations", kind: "destinations" as const } }
				: {}),
		})
	}

	return stages
}

/** The verdict line for the panel header: the first failing/warning stage's summary. */
export function diagnosisVerdict(stages: ReadonlyArray<DiagnosisStage>): {
	readonly status: DiagnosisStageStatus
	readonly summary: string
} {
	const firstFail = stages.find((s) => s.status === "fail")
	if (firstFail) return { status: "fail", summary: firstFail.summary }
	const firstWarn = stages.find((s) => s.status === "warn")
	if (firstWarn) return { status: "warn", summary: firstWarn.summary }
	return { status: "pass", summary: "All stages passing" }
}

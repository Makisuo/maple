import { Schema } from "effect"
import { narrowAlertSignal } from "@/components/ai-triage/breach"
import { signalLabel, type AlertContext } from "./alert-context"

/** The three things Maple can investigate. Kind is carried by the attached resource, not the URL. */
const InvestigationKindSchema = Schema.Literals(["alert", "anomaly", "error", "freeform"])
export type InvestigationKind = typeof InvestigationKindSchema.Type

/** A single labelled fact — shown on the attachment card and folded into the chat preamble. */
export interface InvestigationFact {
	/** Stable machine key for the preamble YAML (e.g. `observed`). */
	key: string
	/** Human label for the attachment card (e.g. `Observed`). */
	label: string
	value: string
}

/**
 * Kind-agnostic context for an investigation chat: the normalized facts a chat
 * thread is seeded with, regardless of whether the subject is an alert, an
 * anomaly, or an error. Drives the pinned attachment card, the first-message
 * preamble, and the starter suggestions.
 */
export interface InvestigationContext {
	kind: InvestigationKind
	/** Focal resource id (alert incident / anomaly incident / error issue). */
	id: string
	/** Human title — rule name, "p95 latency · svc", or the exception type. */
	title: string
	/** Severity token (`critical` | `warning` | `high` | `medium` | `low` | …). */
	severity: string
	/** Short status label, e.g. `Firing` | `Open` | `Resolved`. */
	status: string
	/** Signal type when applicable (alert/anomaly) — drives tool hints + suggestions. */
	signalType?: string
	/** Primary scope for suggestions/preamble (group key or service name). */
	scope?: string
	/** Alert/anomaly evaluation window in minutes (time-scoping hint). */
	windowMinutes?: number
	/** Compact facts shown on the card and emitted as preamble YAML. */
	facts: InvestigationFact[]
	/** Entity references for the preamble + deep links. */
	refs?: {
		serviceName?: string
		ruleId?: string
		ruleName?: string
		detectorKey?: string
		issueId?: string
		incidentId?: string
	}
	/** Prior AI-triage findings, folded into the preamble so the agent builds on them. */
	aiSummary?: string
	aiSuspectedCause?: string
}

/** Stable chat tab id. Alerts keep their legacy `alert-…` id so notification threads continue. */
export const investigationTabId = (ctx: InvestigationContext): string => {
	if (ctx.kind === "alert") return `alert-${ctx.refs?.incidentId ?? ctx.refs?.ruleId ?? ctx.id}`
	return `${ctx.kind}-${ctx.id}`
}

/** Short tab label for the chat sidebar. */
export const investigationTabTitle = (ctx: InvestigationContext): string =>
	ctx.title.length > 28 ? `${ctx.title.slice(0, 28)}…` : ctx.title

const capitalize = (s: string): string => (s.length === 0 ? s : `${s[0]!.toUpperCase()}${s.slice(1)}`)

/** Map a legacy alert chat context onto the generic investigation shape (back-compat shim). */
export const alertContextToInvestigation = (alert: AlertContext): InvestigationContext => {
	const { breach } = narrowAlertSignal(alert)
	const observed = breach
		? `${breach.observed} vs ${breach.threshold}`
		: `${alert.value ?? "n/a"} vs ${alert.threshold}`
	return {
		kind: "alert",
		id: alert.incidentId ?? alert.ruleId,
		title: alert.ruleName,
		severity: alert.severity,
		status: alert.eventType === "resolve" ? "Resolved" : "Firing",
		signalType: alert.signalType,
		scope: alert.groupKey ?? undefined,
		windowMinutes: alert.windowMinutes,
		facts: [
			{ key: "signal", label: "Signal", value: capitalize(signalLabel(alert.signalType)) },
			{ key: "observed", label: "Observed", value: observed },
			{ key: "window", label: "Window", value: `${alert.windowMinutes}m` },
			{ key: "group", label: "Group", value: alert.groupKey ?? "all" },
		],
		refs: {
			ruleId: alert.ruleId,
			ruleName: alert.ruleName,
			...(alert.incidentId ? { incidentId: alert.incidentId } : undefined),
		},
		...(alert.aiSummary ? { aiSummary: alert.aiSummary } : undefined),
		...(alert.aiSuspectedCause ? { aiSuspectedCause: alert.aiSuspectedCause } : undefined),
	}
}

const KIND_NOUN: Record<InvestigationKind, string> = {
	alert: "alert",
	anomaly: "anomaly",
	error: "error",
	freeform: "question",
} satisfies Record<InvestigationKind, string>

export const investigationNoun = (kind: InvestigationKind): string => KIND_NOUN[kind]

/**
 * A scope short enough to sit inside a chip. `scope` is free text: an alert group
 * key is a handful of characters, but a system-seeded investigation can carry a
 * whole sentence the model wrote, and `Slowest traces in ${scope}` then renders a
 * paragraph as a button. Cut at the first clause boundary — the head of such a
 * sentence is reliably the subject ("subscriptions-api public endpoints (GET …)"
 * → "subscriptions-api") — then hard-cap whatever survives.
 */
const CHIP_SCOPE_MAX = 32

export const chipScope = (raw: string): string => {
	const head = raw.split(/[(\n,;—]/)[0]!.trim()
	const text = head.length > 0 ? head : raw.trim()
	if (text.length <= CHIP_SCOPE_MAX) return text
	// A clause this long isn't a scope, it's a sentence — and the subject of that
	// sentence is its first word ("subscriptions-api public endpoints …" →
	// "subscriptions-api"). Prefer that whole word over a mid-word ellipsis.
	const first = text.split(/\s+/)[0]!
	return first.length > CHIP_SCOPE_MAX ? `${first.slice(0, CHIP_SCOPE_MAX - 1).trimEnd()}…` : first
}

const CHIP_PHRASE_MAX = 36

/**
 * The same problem as {@link chipScope} for a different field. An error
 * investigation's title is the exception message, which is routinely a sentence
 * and sometimes a blob of JSON, and `Sample stack traces for ${title}` inherits
 * whatever it is. Unlike a scope there is no subject word to lift out — the
 * front of a message *is* the identifying part — so this truncates instead.
 */
export const chipPhrase = (raw: string): string => {
	const text = raw.split("\n")[0]!.trim()
	return text.length > CHIP_PHRASE_MAX ? `${text.slice(0, CHIP_PHRASE_MAX - 1).trimEnd()}…` : text
}

/** Starter prompts tuned to the kind + signal + scope of the investigation. */
export const investigationSuggestions = (ctx: InvestigationContext): string[] => {
	const rawScope = ctx.scope ?? ctx.refs?.serviceName
	const scope = rawScope ? chipScope(rawScope) : "the affected service"
	const windowM = ctx.windowMinutes ?? 15

	// A diagnosis is already on screen, so "Diagnose X" is the one thing left to
	// ask. Push on the report instead: the useful next move against an AI
	// conclusion is corroborating or breaking it.
	if (ctx.aiSuspectedCause) {
		return [
			"What would confirm this?",
			"What else could explain it?",
			"Show the supporting traces",
			"What should we do first?",
		]
	}

	if (ctx.kind === "freeform") {
		return [
			"Summarize the strongest evidence",
			"What data is still missing?",
			"Show the most relevant traces",
			"What should we do next?",
		]
	}

	if (ctx.kind === "error") {
		const error = chipPhrase(ctx.title)
		return [
			`Sample stack traces for ${error}`,
			`When did ${error} start?`,
			`Which release introduced this?`,
			`Group these errors by endpoint`,
		]
	}

	if (ctx.kind === "anomaly") {
		const sig = ctx.signalType ?? ""
		if (sig.includes("latency")) {
			return [
				`Slowest operations in ${scope} right now`,
				`Top 10 slowest traces in ${scope}`,
				`Compare ${scope} latency to the past week`,
				`Recent deploys or config changes in ${scope}`,
			]
		}
		if (sig.includes("error")) {
			return [
				`Top exceptions in ${scope} in the last ${windowM}m`,
				`Which errors drove the spike?`,
				`Group errors in ${scope} by endpoint`,
				`Sample stack traces per error class`,
			]
		}
		return [
			`What changed in ${scope}?`,
			`Compare ${scope} to the past week`,
			`Upstream callers of ${scope} — any drops?`,
			`Recent deploys in ${scope}`,
		]
	}

	// alert
	const sig = ctx.signalType ?? ""
	if (sig === "p95_latency" || sig === "p99_latency") {
		return [
			`Slowest operations in ${scope} right now`,
			`Top 10 slowest traces in ${scope}`,
			`Compare ${scope} ${signalLabel(sig)} to the past week`,
			`Recent deploys or config changes in ${scope}`,
		]
	}
	if (sig === "error_rate") {
		return [
			`Top exceptions in ${scope} in the last ${windowM}m`,
			`New error types since ${Math.max(windowM * 12, 60)}m ago`,
			`Group errors in ${scope} by endpoint`,
			`Sample stack traces per error class`,
		]
	}
	if (sig === "throughput") {
		return [
			`Plot ${scope} throughput vs yesterday`,
			`Upstream callers of ${scope} — any drops?`,
			`Operations in ${scope} with biggest volume delta`,
		]
	}
	return [`Diagnose ${scope}`, `Recent errors in ${scope}`, `Slowest traces in ${scope}`]
}

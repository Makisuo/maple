import { Option, Schema } from "effect"
import { fromBase64Url, toBase64Url } from "@/lib/base64url"
import { narrowAlertSignal } from "@/components/ai-triage/breach"
import { signalLabel, type AlertContext } from "./alert-context"

/** The three things Maple can investigate. Kind is carried by the attached resource, not the URL. */
const InvestigationKindSchema = Schema.Literals(["alert", "anomaly", "error"])
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

/** Minimal identity carried in the `/investigations/$id?r=` param — the attached resource. */
export interface InvestigationRef {
	kind: InvestigationKind
	id: string
	issueId?: string
}

/** The compact base64url wire shape carried in `/investigations/$id?r=`. */
const InvestigationRefWireSchema = Schema.Struct({
	k: InvestigationKindSchema,
	id: Schema.String,
	i: Schema.optionalKey(Schema.String),
})
const decodeRefWire = Schema.decodeUnknownOption(InvestigationRefWireSchema)

export const encodeInvestigationRef = (ref: InvestigationRef): string =>
	toBase64Url(JSON.stringify({ k: ref.kind, id: ref.id, ...(ref.issueId ? { i: ref.issueId } : {}) }))

export const decodeInvestigationRef = (raw: string): InvestigationRef | undefined => {
	try {
		return Option.match(decodeRefWire(JSON.parse(fromBase64Url(raw))), {
			onNone: () => undefined,
			onSome: (w) => ({ kind: w.k, id: w.id, ...(w.i !== undefined ? { issueId: w.i } : {}) }),
		})
	} catch {
		return undefined
	}
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
			...(alert.incidentId ? { incidentId: alert.incidentId } : {}),
		},
		...(alert.aiSummary ? { aiSummary: alert.aiSummary } : {}),
		...(alert.aiSuspectedCause ? { aiSuspectedCause: alert.aiSuspectedCause } : {}),
	}
}

const KIND_NOUN: Record<InvestigationKind, string> = {
	alert: "alert",
	anomaly: "anomaly",
	error: "error",
}

export const investigationNoun = (kind: InvestigationKind): string => KIND_NOUN[kind]

/** Starter prompts tuned to the kind + signal + scope of the investigation. */
export const investigationSuggestions = (ctx: InvestigationContext): string[] => {
	const scope = ctx.scope ?? ctx.refs?.serviceName ?? "the affected service"
	const windowM = ctx.windowMinutes ?? 15

	if (ctx.kind === "error") {
		return [
			`Sample stack traces for ${ctx.title}`,
			`When did ${ctx.title} start?`,
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

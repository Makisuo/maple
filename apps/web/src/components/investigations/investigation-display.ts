import type { V2Investigation } from "@maple/domain/http/v2"
import { toEpochMs } from "@maple/ui/lib/time-format"

import { SEVERITY_ORDER, severityRank } from "@/components/errors/severity-badge"
import { CONFIDENCE_RANK } from "./confidence-meter"

export type InvestigationKindKey = "alert" | "error" | "anomaly" | "question"

/**
 * The exact title the API writes when the seed context carried no name of its
 * own — `snapshotFor` (apps/api/src/lib/ai-triage-enqueue.ts) and
 * `fallbackSnapshot` (InvestigationService) both emit this string, and nothing
 * else does. Matching it precisely is what lets the list promote the
 * informative field into the slot the placeholder was occupying.
 */
const GENERIC_TITLE = /^(Error|Anomaly|Alert) incident$/

const trimmed = (value: string | null | undefined): string | null => {
	const text = value?.trim()
	return text ? text : null
}

export const investigationKindKey = (subject: V2Investigation["subject"]): InvestigationKindKey =>
	subject.type === "freeform" ? "question" : subject.incident_kind

/**
 * The most specific human sentence available. A snapshot title of
 * "Alert incident" says nothing the Kind marker beside it doesn't already say,
 * so it loses to the scope — which, on those rows, is the only text carrying
 * what the incident was actually about.
 */
export function investigationHeadline(investigation: V2Investigation): string {
	const title = trimmed(investigation.snapshot.title)
	if (title !== null && !GENERIC_TITLE.test(title)) return title
	return (
		trimmed(investigation.snapshot.scope) ??
		trimmed(investigation.report?.affectedScope) ??
		title ??
		"Investigation"
	)
}

/** The scope line, unless the headline already promoted it. */
export function investigationScope(investigation: V2Investigation): string | null {
	const scope = trimmed(investigation.snapshot.scope)
	if (scope === null) return null
	return scope === investigationHeadline(investigation) ? null : scope
}

export type InvestigationFinding =
	| { readonly kind: "pending"; readonly text: string }
	| { readonly kind: "cause"; readonly text: string }
	/** Nothing established, but something ruled out. Not a failure. */
	| { readonly kind: "partial"; readonly text: string }
	| { readonly kind: "failure"; readonly text: string }
	| { readonly kind: "none" }

/**
 * What Maple concluded — the column the list was missing. Every state has
 * something to say: a running pass says it is running, and a failed pass says
 * why, which was on the wire and rendered nowhere.
 */
export function investigationFinding(investigation: V2Investigation): InvestigationFinding {
	if (investigation.status === "investigating") {
		return { kind: "pending", text: "Gathering evidence…" }
	}
	// Before `failed`, and a distinct kind rather than a `cause` with a caveat.
	// The hub is scanned, not read: a partial that renders identically to a
	// confirmed cause is worse than one that renders as a failure, because it
	// makes an unconfirmed lead look like an answer.
	if (investigation.status === "inconclusive") {
		const report = investigation.report
		const text = trimmed(report?.suspectedCause) ?? trimmed(report?.summary)
		return { kind: "partial", text: text ?? "No cause established — see what was ruled out." }
	}
	if (investigation.status === "failed") {
		return {
			kind: "failure",
			text: trimmed(investigation.error) ?? "The pass failed without recording a reason.",
		}
	}
	const report = investigation.report
	if (report) {
		const text = trimmed(report.suspectedCause) ?? trimmed(report.summary)
		if (text !== null) return { kind: "cause", text }
	}
	return { kind: "none" }
}

/** Case-insensitive match across everything the row actually renders. */
export function matchesQuery(investigation: V2Investigation, query: string): boolean {
	const needle = query.trim().toLowerCase()
	if (!needle) return true
	const finding = investigationFinding(investigation)
	const haystack = [
		investigationHeadline(investigation),
		investigation.snapshot.scope,
		finding.kind === "none" ? null : finding.text,
	]
	return haystack.some((value) => value?.toLowerCase().includes(needle))
}

export type InvestigationSortKey = "updated" | "severity" | "confidence"
export type SortDirection = "asc" | "desc"

const CONFIDENCE_LEVELS = 3

export const investigationSeverity = (investigation: V2Investigation) =>
	investigation.severity ?? investigation.snapshot.severity

/**
 * Sort weight, where a higher number means "more" — more recent, more severe,
 * more confident — so `desc` is always the reading a person expects from a
 * first click. `null` means the row has no value for this key at all.
 */
function sortWeight(investigation: V2Investigation, key: InvestigationSortKey): number | null {
	switch (key) {
		case "updated": {
			const ms = toEpochMs(investigation.updated_at)
			return Number.isFinite(ms) ? ms : null
		}
		case "severity": {
			const severity = investigationSeverity(investigation)
			return severity === null ? null : SEVERITY_ORDER.length - severityRank(severity)
		}
		case "confidence": {
			const confidence = investigation.confidence
			return confidence === null ? null : CONFIDENCE_LEVELS - CONFIDENCE_RANK[confidence]
		}
	}
}

const updatedWeight = (investigation: V2Investigation): number => {
	const ms = toEpochMs(investigation.updated_at)
	return Number.isFinite(ms) ? ms : 0
}

/**
 * Rows with no value for the active key sink to the bottom in both directions —
 * an ascending sort by severity should surface the least severe row that has a
 * severity, not the ones that never got one. Ties fall back to newest-updated so
 * the order is stable across re-sorts.
 */
export function sortInvestigations(
	investigations: ReadonlyArray<V2Investigation>,
	key: InvestigationSortKey,
	direction: SortDirection,
): ReadonlyArray<V2Investigation> {
	return [...investigations].sort((a, b) => {
		const left = sortWeight(a, key)
		const right = sortWeight(b, key)
		if (left !== right) {
			if (left === null) return 1
			if (right === null) return -1
			return direction === "desc" ? right - left : left - right
		}
		return updatedWeight(b) - updatedWeight(a) || a.id.localeCompare(b.id)
	})
}

/* -------------------------------------------------------------------------------------------------
 * Durations
 * -----------------------------------------------------------------------------------------------*/

export interface Elapsed {
	value: string
	unit: string
}

const pad = (n: number) => String(n).padStart(2, "0")

/**
 * A duration split into the number and its unit, so the number can carry the
 * display weight and the unit ride its baseline.
 *
 * Deliberately not `formatDuration`, which is tuned for span durations: it gives
 * seconds two decimals ("7.04s") and minutes one ("1.4min"). At this display
 * weight the decimals read as false precision, and on the live Elapsed stat a
 * tenth-of-a-minute resolution sits frozen for six seconds and then lurches.
 * Clock notation past a minute keeps every second visible.
 *
 * It lives here rather than in `verdict-card` because the provenance canvas
 * stamps the same elapsed time on its investigation node, and having one
 * component import the other for it built an import cycle that threw at runtime.
 */
export const splitDuration = (ms: number): Elapsed => {
	// A pass that died before it started is a real case (`workflow_binding_unavailable`
	// fails in microseconds), and "0 µs" reads as a broken clock rather than an
	// instant failure. Sub-second resolution buys nothing at this display size.
	if (ms < 1000) return { value: "<1", unit: "s" }
	const totalSeconds = Math.floor(ms / 1000)
	if (totalSeconds < 60) return { value: String(totalSeconds), unit: "s" }
	const seconds = totalSeconds % 60
	const totalMinutes = Math.floor(totalSeconds / 60)
	if (totalMinutes < 60) return { value: `${totalMinutes}:${pad(seconds)}`, unit: "min" }
	const minutes = totalMinutes % 60
	const hours = Math.floor(totalMinutes / 60)
	return { value: `${hours}:${pad(minutes)}:${pad(seconds)}`, unit: "h" }
}

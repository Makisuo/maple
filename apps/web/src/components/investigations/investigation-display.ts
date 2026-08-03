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

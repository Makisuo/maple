// ---------------------------------------------------------------------------
// Error-spike consolidation + incident reopen — pure functions, no I/O.
//
// One production event (a bad deploy, a dependency outage) usually surfaces
// as several error fingerprints spiking on the same service at the same time.
// Opening one incident per fingerprint floods the feed and multiplies AI
// triage cost. Instead, fingerprints whose breach onset is close enough to an
// already-open spike incident on the same service+env ATTACH to it. The
// co-onset window is the evidence gate: a fingerprint spiking hours into an
// unrelated incident gets its own incident.
//
// Reopen: a series re-breaching shortly after its incident resolved is the
// same event flapping, not a new one. Within the reopen window the prior
// incident reopens (keeping its triage result) instead of inserting a row.
// ---------------------------------------------------------------------------

import {
	AnomalyIncidentSeverity,
	type AnomalyIncidentStatus,
	type AnomalyResolveReason,
} from "@maple/domain/http"
import { Array as Arr, Option, Schema } from "effect"

/**
 * Attach only when the new fingerprint's breach onset falls within this span
 * of the incident's own onset (or latest reopen) — co-onset on the same
 * service+env is the "same underlying issue" evidence.
 */
export const SPIKE_ATTACH_WINDOW_MS = 30 * 60 * 1000

/** Re-breach within this span of a resolve reopens the prior incident. */
export const REOPEN_WINDOW_MS = 6 * 60 * 60 * 1000

/** Entry-list cap; later fingerprints still share the incident untracked. */
export const MAX_FINGERPRINT_ENTRIES = 50

/**
 * One persisted entry of an incident's `fingerprintsJson` column — the
 * epoch-ms storage variant of the HTTP `AnomalyIncidentFingerprint` document.
 * The document converts `attachedAt`/`resolvedAt` to ISO strings and brands
 * `errorIssueId` at read time; the stored shape additionally carries the
 * `detectorKey` the document does not expose.
 */
export const IncidentFingerprintEntry = Schema.Struct({
	fingerprintHash: Schema.String,
	errorIssueId: Schema.NullOr(Schema.String),
	detectorKey: Schema.String,
	openedValue: Schema.Number,
	lastValue: Schema.Number,
	severity: AnomalyIncidentSeverity,
	attachedAt: Schema.Number,
	resolvedAt: Schema.NullOr(Schema.Number),
})
export type IncidentFingerprintEntry = Schema.Schema.Type<typeof IncidentFingerprintEntry>

/** The incident columns the fingerprint helpers need. */
export interface IncidentFingerprintSource {
	readonly detectorKey: string
	readonly fingerprintHash: string | null
	readonly errorIssueId: string | null
	readonly severity: AnomalyIncidentSeverity
	readonly openedValue: number
	readonly lastObservedValue: number
	readonly firstTriggeredAt: number
	readonly fingerprintsJson: string
}

const decodeStoredEntryList = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.Unknown)))
const decodeEntryResult = Schema.decodeUnknownResult(IncidentFingerprintEntry)

/**
 * Parse an incident's fingerprint entries. Malformed JSON (or a non-array)
 * yields no entries; invalid elements inside a valid array are skipped.
 * Incidents created before consolidation (or by older code) have an empty
 * list; seed it from the incident's own primary-fingerprint columns so they
 * behave as one-entry consolidated incidents.
 */
export function parseFingerprints(row: IncidentFingerprintSource): IncidentFingerprintEntry[] {
	const stored = Option.getOrElse(decodeStoredEntryList(row.fingerprintsJson), () => [])
	const entries = Arr.filterMap(stored, (value) => decodeEntryResult(value))
	if (entries.length === 0 && row.fingerprintHash !== null) {
		return [
			{
				fingerprintHash: row.fingerprintHash,
				errorIssueId: row.errorIssueId,
				detectorKey: row.detectorKey,
				openedValue: row.openedValue,
				lastValue: row.lastObservedValue,
				severity: row.severity,
				attachedAt: row.firstTriggeredAt,
				resolvedAt: null,
			},
		]
	}
	return entries
}

export const serializeFingerprints = (entries: ReadonlyArray<IncidentFingerprintEntry>): string =>
	JSON.stringify(entries)

/**
 * Insert or update one fingerprint's entry. New entries beyond the cap are
 * dropped (the fingerprint still shares the incident, just untracked).
 */
export function upsertFingerprintEntry(
	entries: ReadonlyArray<IncidentFingerprintEntry>,
	entry: IncidentFingerprintEntry,
): IncidentFingerprintEntry[] {
	const existing = entries.findIndex((e) => e.fingerprintHash === entry.fingerprintHash)
	if (existing >= 0) {
		const next = [...entries]
		next[existing] = entry
		return next
	}
	if (entries.length >= MAX_FINGERPRINT_ENTRIES) return [...entries]
	return [...entries, entry]
}

export function markFingerprintResolved(
	entries: ReadonlyArray<IncidentFingerprintEntry>,
	fingerprintHash: string,
	nowMs: number,
): IncidentFingerprintEntry[] {
	return entries.map((e) => (e.fingerprintHash === fingerprintHash ? { ...e, resolvedAt: nowMs } : e))
}

/** Max severity over still-firing entries; `fallback` when none are tracked. */
export function headlineSeverity(
	entries: ReadonlyArray<IncidentFingerprintEntry>,
	fallback: AnomalyIncidentSeverity,
): AnomalyIncidentSeverity {
	const active = entries.filter((e) => e.resolvedAt === null)
	if (active.length === 0) return fallback
	return active.some((e) => e.severity === "critical") ? "critical" : "warning"
}

/** Co-onset evidence gate for attaching a fingerprint to an open incident. */
export function canAttach(
	incident: { readonly firstTriggeredAt: number; readonly lastReopenedAt: number | null },
	nowMs: number,
): boolean {
	const onset = Math.max(incident.firstTriggeredAt, incident.lastReopenedAt ?? 0)
	return nowMs - onset <= SPIKE_ATTACH_WINDOW_MS
}

/**
 * A re-breach reopens the prior incident only when it auto-resolved (manual
 * resolves are a user saying "stop") and the resolve is recent enough to be
 * the same event flapping.
 */
export function shouldReopen(
	prior: { readonly status: AnomalyIncidentStatus; readonly resolveReason: AnomalyResolveReason | null },
	lastResolvedAt: number | null,
	nowMs: number,
): boolean {
	if (prior.status !== "resolved") return false
	if (prior.resolveReason !== "returned_to_baseline" && prior.resolveReason !== "no_data") return false
	if (lastResolvedAt === null) return false
	return nowMs - lastResolvedAt <= REOPEN_WINDOW_MS
}

export const attachKeyFor = (serviceName: string, deploymentEnv: string): string =>
	`${serviceName}\u0000${deploymentEnv}`

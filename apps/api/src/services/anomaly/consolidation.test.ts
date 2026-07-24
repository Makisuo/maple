import { describe, expect, it } from "vitest"
import {
	attachKeyFor,
	canAttach,
	headlineSeverity,
	markFingerprintResolved,
	MAX_FINGERPRINT_ENTRIES,
	parseFingerprints,
	REOPEN_WINDOW_MS,
	serializeFingerprints,
	shouldReopen,
	SPIKE_ATTACH_WINDOW_MS,
	upsertFingerprintEntry,
	type IncidentFingerprintEntry,
} from "./consolidation"

const nowMs = Date.parse("2026-06-12T12:00:00Z")

const entry = (overrides: Partial<IncidentFingerprintEntry> = {}): IncidentFingerprintEntry => ({
	fingerprintHash: "fp1",
	errorIssueId: null,
	detectorKey: "error_spike:production:fp1",
	openedValue: 14,
	lastValue: 14,
	severity: "warning",
	attachedAt: nowMs,
	resolvedAt: null,
	...overrides,
})

const incidentRow = (overrides: Partial<Parameters<typeof parseFingerprints>[0]> = {}) => ({
	detectorKey: "error_spike:production:fp1",
	fingerprintHash: "fp1" as string | null,
	errorIssueId: "issue_1" as string | null,
	severity: "warning" as const,
	openedValue: 14,
	lastObservedValue: 20,
	firstTriggeredAt: nowMs - 10 * 60 * 1000,
	fingerprintsJson: "[]",
	...overrides,
})

describe("parseFingerprints", () => {
	it("seeds a primary entry from the incident columns when the list is empty", () => {
		const entries = parseFingerprints(incidentRow())
		expect(entries).toHaveLength(1)
		expect(entries[0]).toMatchObject({
			fingerprintHash: "fp1",
			errorIssueId: "issue_1",
			openedValue: 14,
			lastValue: 20,
			resolvedAt: null,
		})
	})

	it("returns stored entries verbatim when present", () => {
		const stored = [entry(), entry({ fingerprintHash: "fp2" })]
		const entries = parseFingerprints(incidentRow({ fingerprintsJson: JSON.stringify(stored) }))
		expect(entries).toEqual(stored)
	})

	it("returns no entries for golden-signal incidents", () => {
		expect(parseFingerprints(incidentRow({ fingerprintHash: null }))).toEqual([])
	})

	it("tolerates malformed JSON by reseeding", () => {
		const entries = parseFingerprints(incidentRow({ fingerprintsJson: "{not json" }))
		expect(entries).toHaveLength(1)
		expect(entries[0]!.fingerprintHash).toBe("fp1")
	})
})

describe("upsertFingerprintEntry", () => {
	it("replaces an existing fingerprint's entry", () => {
		const next = upsertFingerprintEntry([entry()], entry({ lastValue: 99 }))
		expect(next).toHaveLength(1)
		expect(next[0]!.lastValue).toBe(99)
	})

	it("appends new fingerprints up to the cap", () => {
		const full = Array.from({ length: MAX_FINGERPRINT_ENTRIES }, (_, i) =>
			entry({ fingerprintHash: `fp${i}` }),
		)
		const next = upsertFingerprintEntry(full, entry({ fingerprintHash: "overflow" }))
		expect(next).toHaveLength(MAX_FINGERPRINT_ENTRIES)
		expect(next.some((e) => e.fingerprintHash === "overflow")).toBe(false)
		// Updates to entries already inside the cap still apply.
		const updated = upsertFingerprintEntry(full, entry({ fingerprintHash: "fp0", lastValue: 7 }))
		expect(updated.find((e) => e.fingerprintHash === "fp0")!.lastValue).toBe(7)
	})

	it("round-trips through serialize/parse", () => {
		const entries = [entry(), entry({ fingerprintHash: "fp2", severity: "critical" })]
		const parsed = parseFingerprints(incidentRow({ fingerprintsJson: serializeFingerprints(entries) }))
		expect(parsed).toEqual(entries)
	})
})

describe("headlineSeverity", () => {
	it("takes the max severity over unresolved entries", () => {
		const entries = [entry(), entry({ fingerprintHash: "fp2", severity: "critical" })]
		expect(headlineSeverity(entries, "warning")).toBe("critical")
	})

	it("ignores resolved entries", () => {
		const entries = [entry(), entry({ fingerprintHash: "fp2", severity: "critical", resolvedAt: nowMs })]
		expect(headlineSeverity(entries, "warning")).toBe("warning")
	})

	it("falls back when nothing is tracked", () => {
		expect(headlineSeverity([], "critical")).toBe("critical")
	})
})

describe("markFingerprintResolved", () => {
	it("stamps only the matching entry", () => {
		const next = markFingerprintResolved([entry(), entry({ fingerprintHash: "fp2" })], "fp2", nowMs)
		expect(next.find((e) => e.fingerprintHash === "fp1")!.resolvedAt).toBeNull()
		expect(next.find((e) => e.fingerprintHash === "fp2")!.resolvedAt).toBe(nowMs)
	})

	it("keeps a consolidated incident active until every fingerprint recovers", () => {
		const attached = [entry(), entry({ fingerprintHash: "fp2" })]
		const oneRecovered = markFingerprintResolved(attached, "fp1", nowMs)
		expect(oneRecovered.some((candidate) => candidate.resolvedAt === null)).toBe(true)

		const allRecovered = markFingerprintResolved(oneRecovered, "fp2", nowMs + 5 * 60 * 1000)
		expect(allRecovered.every((candidate) => candidate.resolvedAt !== null)).toBe(true)
	})
})

describe("canAttach", () => {
	it("allows co-onset fingerprints within the attach window", () => {
		expect(
			canAttach({ firstTriggeredAt: nowMs - SPIKE_ATTACH_WINDOW_MS + 1, lastReopenedAt: null }, nowMs),
		).toBe(true)
	})

	it("rejects fingerprints spiking long after the incident's onset", () => {
		expect(canAttach({ firstTriggeredAt: nowMs - 3 * 60 * 60 * 1000, lastReopenedAt: null }, nowMs)).toBe(
			false,
		)
	})

	it("restarts the window from a reopen", () => {
		expect(
			canAttach(
				{ firstTriggeredAt: nowMs - 3 * 60 * 60 * 1000, lastReopenedAt: nowMs - 5 * 60 * 1000 },
				nowMs,
			),
		).toBe(true)
	})
})

describe("shouldReopen", () => {
	const resolved = (reason: "returned_to_baseline" | "no_data" | "manual") => ({
		status: "resolved" as const,
		resolveReason: reason,
	})

	it("reopens auto-resolved incidents within the window", () => {
		expect(shouldReopen(resolved("returned_to_baseline"), nowMs - 2 * 60 * 60 * 1000, nowMs)).toBe(true)
		expect(shouldReopen(resolved("no_data"), nowMs - 2 * 60 * 60 * 1000, nowMs)).toBe(true)
	})

	it("never reopens a manual resolve", () => {
		expect(shouldReopen(resolved("manual"), nowMs - 5 * 60 * 1000, nowMs)).toBe(false)
	})

	it("does not reopen past the window", () => {
		expect(shouldReopen(resolved("returned_to_baseline"), nowMs - REOPEN_WINDOW_MS - 1, nowMs)).toBe(
			false,
		)
	})

	it("does not reopen an incident that is somehow still open", () => {
		expect(shouldReopen({ status: "open", resolveReason: null }, nowMs - 5 * 60 * 1000, nowMs)).toBe(
			false,
		)
	})
})

describe("attachKeyFor", () => {
	it("separates service and env unambiguously", () => {
		expect(attachKeyFor("svc a", "env")).not.toBe(attachKeyFor("svc", "a env"))
	})
})

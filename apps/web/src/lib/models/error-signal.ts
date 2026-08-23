// One fingerprint, all of what we know about it.
//
// `/errors` and `/errors/issues` were two renderings of the same object: the
// warehouse groups error events by `FingerprintHash`, and `error_issues` is
// keyed on that same hash (ErrorsService's per-minute tick upserts one issue
// per fingerprint it observes, so the issue table is the complete set, not a
// triaged subset of it). Neither view alone answered the triage question —
// the warehouse knew the volume and shape, Postgres knew the severity, state
// and owner, and the investigation lived on a third route.
//
// An `ErrorSignal` is those three joined on the fingerprint hash.

import type {
	ErrorIssueDocument,
	ErrorIssueId,
	IssueKind,
	IssueSeverity,
	WorkflowState,
} from "@maple/domain/http"
import type { V2Investigation } from "@maple/domain/http/v2"

import type { ErrorByType } from "@/api/warehouse/errors"
import type { ErrorsSparkSeries } from "@/api/warehouse/errors"

/**
 * What a row says about where this fingerprint stands. One slot, resolved by
 * precedence, replacing the four badge systems a row used to carry (workflow
 * state, "Open incident", the investigation that lived on another route, and
 * the kind badge that repeated what the title already said).
 */
export type SignalState =
	/** An incident is open right now. Nothing else about the row matters more. */
	| { readonly kind: "incident" }
	/** Maple is looking at it, or already has an answer. Outranks workflow state:
	 *  "diagnosed" is more actionable than "todo". */
	| {
			readonly kind: "investigation"
			readonly status: V2Investigation["status"]
			readonly confidence: V2Investigation["confidence"]
			readonly investigationId: string
	  }
	/** Nothing automated is happening — where a human left it. */
	| { readonly kind: "workflow"; readonly state: WorkflowState }

export interface ErrorSignal {
	readonly id: ErrorIssueId
	readonly fingerprintHash: string
	/** `TypeError` — the identity, and the row's dominant element. */
	readonly title: string
	/** `Cannot read 'id' of undefined` — the detail, dimmed beside the title. */
	readonly detail: string
	readonly serviceName: string
	readonly severity: IssueSeverity | null
	readonly state: SignalState
	/** Occurrences in the selected window, from the warehouse. `null` when the
	 *  fingerprint had none — an issue that has gone quiet, which is a fact worth
	 *  drawing rather than a zero to hide. */
	readonly windowCount: number | null
	/** Occurrences since the issue opened, from Postgres. Always known. */
	readonly totalCount: number
	readonly affectedServicesCount: number | null
	readonly spark: ReadonlyArray<{ readonly bucket: string; readonly count: number }>
	readonly lastSeenAt: string
	readonly firstSeenAt: string
	readonly assignee: ErrorIssueDocument["assignedActor"]
	readonly issue: ErrorIssueDocument
}

/** Investigations that still say something about the present. A resolved one is
 *  history — the row should fall back to its workflow state rather than claim an
 *  investigation is live. */
const LIVE_INVESTIGATION_STATUSES: ReadonlyArray<V2Investigation["status"]> = [
	"investigating",
	"diagnosed",
	"inconclusive",
	"failed",
]

/**
 * Index investigations by the issue they hang off, keeping the most recent per
 * issue. An issue can be investigated more than once (retries, follow-ups); the
 * row speaks for the latest pass.
 */
export function indexInvestigationsByIssue(
	investigations: ReadonlyArray<V2Investigation>,
): ReadonlyMap<string, V2Investigation> {
	const byIssue = new Map<string, V2Investigation>()
	for (const investigation of investigations) {
		if (investigation.subject.type !== "incident") continue
		const issueId = investigation.subject.issue_id
		if (issueId === null) continue
		if (!LIVE_INVESTIGATION_STATUSES.includes(investigation.status)) continue
		const existing = byIssue.get(issueId)
		if (existing === undefined || investigation.created_at > existing.created_at) {
			byIssue.set(issueId, investigation)
		}
	}
	return byIssue
}

/** The slice of an investigation a row actually renders. Structural rather than
 *  `Pick<V2Investigation, …>` so the id stays a plain string — the row only
 *  builds a link out of it, and the branded form would force test fixtures
 *  through a cast. */
export interface InvestigationSummary {
	readonly id: string
	readonly status: V2Investigation["status"]
	readonly confidence: V2Investigation["confidence"]
}

/**
 * Open incident › live investigation › workflow state.
 *
 * Takes only the two issue fields it reads rather than a whole
 * `ErrorIssueDocument`, so the precedence can be exercised without standing up
 * a full document (and so a test fixture cannot drift from the real shape by
 * being cast into place).
 */
export function resolveSignalState(
	issue: { readonly hasOpenIncident: boolean; readonly workflowState: WorkflowState },
	investigation: InvestigationSummary | undefined,
): SignalState {
	if (issue.hasOpenIncident) return { kind: "incident" }
	if (investigation !== undefined) {
		return {
			kind: "investigation",
			status: investigation.status,
			confidence: investigation.confidence,
			investigationId: investigation.id,
		}
	}
	return { kind: "workflow", state: issue.workflowState }
}

/**
 * The fingerprints a sparkline can actually be drawn for.
 *
 * Only `kind === "error"` issues carry a real ClickHouse fingerprint (a decimal
 * UInt64 string). Alert and integration issues reuse the column for a synthetic
 * key — `alert:{ruleId}:{groupKey}`, `planetscale:{database}:{event}` — which
 * `toUInt64()` rejects, failing the whole batched spark query for every row on
 * screen. `ErrorIssueReadModelsService.getIssue` skips the warehouse for the
 * same reason.
 */
export function sparkFingerprintHashes(
	issues: ReadonlyArray<{ readonly kind: IssueKind; readonly fingerprintHash: string }>,
): ReadonlyArray<string> {
	return issues.filter((issue) => issue.kind === "error").map((issue) => issue.fingerprintHash)
}

/**
 * Join issues (the spine) with warehouse volume and trend.
 *
 * Issue-first rather than warehouse-first: the issue table covers every
 * fingerprint, carries the triage facts, and streams live, while the warehouse
 * only knows about the selected window. A fingerprint with no rows in the
 * window still belongs in the list — it just has nothing to draw.
 */
export function buildErrorSignals(input: {
	readonly issues: ReadonlyArray<ErrorIssueDocument>
	readonly warehouse: ReadonlyArray<ErrorByType>
	readonly spark: ReadonlyArray<ErrorsSparkSeries>
	readonly investigations: ReadonlyMap<string, V2Investigation>
}): ReadonlyArray<ErrorSignal> {
	const volumeByHash = new Map(input.warehouse.map((row) => [row.fingerprintHash, row]))
	const sparkByHash = new Map(input.spark.map((series) => [series.fingerprintHash, series.points]))

	return input.issues.map((issue) => {
		const volume = volumeByHash.get(issue.fingerprintHash)
		return {
			id: issue.id,
			fingerprintHash: issue.fingerprintHash,
			title: issue.exceptionType || "Unknown error",
			detail: issue.exceptionMessage ?? "",
			serviceName: issue.serviceName,
			severity: issue.severity,
			state: resolveSignalState(issue, input.investigations.get(issue.id)),
			windowCount: volume ? volume.count : null,
			totalCount: issue.occurrenceCount,
			affectedServicesCount: volume ? volume.affectedServicesCount : null,
			spark: sparkByHash.get(issue.fingerprintHash) ?? [],
			lastSeenAt: issue.lastSeenAt,
			firstSeenAt: issue.firstSeenAt,
			assignee: issue.leaseHolder ?? issue.assignedActor,
			issue,
		}
	})
}

/**
 * Fill the gaps in a sparse series so the drawn shape is honest about quiet
 * periods. The warehouse emits no row for a bucket with no errors, and a line
 * drawn straight through those gaps reads as steady traffic rather than
 * silence.
 */
export function densifySpark(
	points: ReadonlyArray<{ readonly bucket: string; readonly count: number }>,
	window: { readonly startMs: number; readonly endMs: number; readonly bucketMs: number },
): ReadonlyArray<number> {
	if (window.bucketMs <= 0) return []
	const bucketCount = Math.ceil((window.endMs - window.startMs) / window.bucketMs)
	if (bucketCount <= 0 || !Number.isFinite(bucketCount)) return []

	const dense = new Array<number>(bucketCount).fill(0)
	for (const point of points) {
		const ms = Date.parse(point.bucket)
		if (!Number.isFinite(ms)) continue
		const index = Math.floor((ms - window.startMs) / window.bucketMs)
		if (index < 0 || index >= bucketCount) continue
		dense[index] = (dense[index] ?? 0) + point.count
	}
	return dense
}

/**
 * How much of the window's volume landed in its last fifth.
 *
 * This is what makes a row's shape legible at a glance: 12k errors spread over
 * twelve hours and 12k errors that all arrived in the last forty minutes are
 * the same number and completely different problems. Returns `null` when the
 * window is too quiet to say anything — a burst ratio computed off three events
 * is noise dressed as a signal.
 */
const SURGE_MIN_EVENTS = 20
const SURGE_TAIL_FRACTION = 0.2

export function surgeRatio(dense: ReadonlyArray<number>): number | null {
	const total = dense.reduce((sum, value) => sum + value, 0)
	if (total < SURGE_MIN_EVENTS) return null
	const tailLength = Math.max(1, Math.round(dense.length * SURGE_TAIL_FRACTION))
	const tail = dense.slice(dense.length - tailLength).reduce((sum, value) => sum + value, 0)
	// Against the window's own average tail, so "surging" means "faster than it
	// has been", not merely "nonzero at the end".
	const expected = total * (tailLength / dense.length)
	if (expected <= 0) return null
	return tail / expected
}

/**
 * The detail page's counterpart to {@link indexInvestigationsByIssue}.
 *
 * That one filters a mixed list down to the incident-subject investigations it
 * can attribute to an issue. The detail page already queries by `issue_id`, so
 * attribution is settled — but "is this pass still saying something about the
 * present" is not, and a resolved investigation must fall back to the workflow
 * state on the detail page for exactly the reason it does on a row.
 */
export function liveInvestigationSummary(
	investigation: V2Investigation | null,
): InvestigationSummary | undefined {
	if (investigation === null) return undefined
	if (!LIVE_INVESTIGATION_STATUSES.includes(investigation.status)) return undefined
	return {
		id: investigation.id,
		status: investigation.status,
		confidence: investigation.confidence,
	}
}

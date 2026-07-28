import { Effect, Option } from "effect"
import * as CH from "@maple/query-engine/ch"
import type { TenantContext } from "../services/AuthService"
import type { WarehouseQueryServiceShape } from "./WarehouseQueryService"

/**
 * "Is this signal quiet because it recovered, or because we stopped receiving
 * data?"
 *
 * Every path that reads an absent symptom as health has to answer that first.
 * An ingest outage, a sampling change, a renamed service, or an org hitting its
 * billing limit (the gateway 402s and drops the spans) are all indistinguishable
 * from a fixed incident if you only look at the alerting signal itself.
 *
 * The probe compares a verification window against a baseline window ending at
 * incident onset, so it answers "did the traffic that produced this incident go
 * away?" rather than "is there traffic right now" — a service that was always
 * quiet must not be permanently ineligible for resolution.
 *
 * Fail-closed: a probe that errors returns `dataFlowing: false`. Not resolving
 * is recoverable on the next tick; resolving a live incident is not.
 *
 * The verdict maths is pure and lives at the bottom of this file (mirroring the
 * split in services/anomaly/state-machine.ts) so the interesting decisions are
 * testable without standing up a warehouse.
 */

/** Fraction of baseline volume the verification window must retain. */
export const LIVENESS_MIN_VOLUME_RATIO = 0.5

/**
 * Max divergence between the raw and sample-corrected volume ratios before we
 * call it a sampling change rather than a traffic change. Raw counts collapsing
 * while corrected counts hold steady is the signature of a sampler being turned
 * down, and it must not read as recovery.
 */
export const LIVENESS_MAX_SAMPLING_DELTA = 0.2

export type LivenessReason =
	| "ok"
	/** A service that carried baseline traffic is now emitting nothing. */
	| "no_data"
	/** Volume survived but collapsed below the retention floor. */
	| "volume_collapsed"
	/** Raw and sample-corrected ratios diverged — the sampler changed, not the traffic. */
	| "sampling_changed"
	/** The probe itself failed. Fail-closed. */
	| "probe_failed"
	/** No baseline traffic to compare against; nothing provable either way. */
	| "no_baseline"

export interface LivenessVerdict {
	readonly dataFlowing: boolean
	readonly reason: LivenessReason
	readonly observedCount: number
	readonly baselineCount: number
	/** observed / baseline on sample-corrected counts; null when there is no baseline. */
	readonly ratio: number | null
	/** |rawRatio - correctedRatio|; null when either is unavailable. */
	readonly samplingDelta: number | null
}

export interface ServiceWindowTotals {
	readonly spanCount: number
	readonly estimatedSpanCount: number
}

/** Observed and baseline totals for one service. `null` means the probe failed. */
export type ServiceWindowPair = readonly [
	observed: ServiceWindowTotals | null,
	baseline: ServiceWindowTotals | null,
]

/**
 * The slice of the warehouse this probe needs. Narrow on purpose: it keeps the
 * dependency legible, and it keeps `WarehouseQueryService` out of the R channel
 * of callers that already resolved the service inside their own closure.
 */
export type LivenessWarehouse = Pick<
	WarehouseQueryServiceShape,
	"compiledQuery" | "compiledQueryFirst"
>

export interface LivenessProbeInput {
	readonly warehouse: LivenessWarehouse
	readonly tenant: TenantContext
	/** Services the subject is scoped to. Empty probes the org as a whole. */
	readonly serviceNames: ReadonlyArray<string>
	/** The quiet window being interpreted as recovery. */
	readonly windowStartMs: number
	readonly windowEndMs: number
	/** Same-length window ending at incident onset. */
	readonly baselineStartMs: number
	readonly baselineEndMs: number
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

const toWarehouseDateTime = (epochMs: number) =>
	new Date(epochMs).toISOString().slice(0, 19).replace("T", " ")

const EMPTY_TOTALS: ServiceWindowTotals = { spanCount: 0, estimatedSpanCount: 0 }

/**
 * `null` means the probe itself failed, and it must stay distinguishable from a
 * genuine zero: collapsing the two would let a warehouse hiccup on the BASELINE
 * window read as "this service never had traffic", which is a fail-open path
 * straight to resolving a live incident.
 */
const probeServiceWindow = (
	warehouse: LivenessWarehouse,
	tenant: TenantContext,
	serviceName: string,
	startMs: number,
	endMs: number,
): Effect.Effect<ServiceWindowTotals | null, never> =>
	Effect.gen(function* () {
		const compiled = CH.compile(
			CH.serviceLivenessQuery(),
			{
				orgId: tenant.orgId,
				serviceName,
				startTime: toWarehouseDateTime(startMs),
				endTime: toWarehouseDateTime(endMs),
			},
			{ rowSchema: CH.serviceLivenessRowSchema },
		)
		const row = yield* warehouse.compiledQueryFirst(tenant, compiled, {
			profile: "list",
			context: "telemetryLiveness",
		})
		if (Option.isNone(row)) return EMPTY_TOTALS
		return {
			spanCount: row.value.spanCount,
			estimatedSpanCount: row.value.estimatedSpanCount,
		}
	}).pipe(Effect.orElseSucceed(() => null))

/** `null` on probe failure, for the same reason as `probeServiceWindow`. */
const probeOrgWindow = (
	warehouse: LivenessWarehouse,
	tenant: TenantContext,
	startMs: number,
	endMs: number,
): Effect.Effect<number | null, never> =>
	Effect.gen(function* () {
		const compiled = CH.compileUnion(
			CH.orgTelemetryPulseQuery(),
			{
				orgId: tenant.orgId,
				startTime: toWarehouseDateTime(startMs),
				endTime: toWarehouseDateTime(endMs),
			},
			{ rowSchema: CH.telemetryPulseRowSchema },
		)
		const rows = yield* warehouse.compiledQuery(tenant, compiled, {
			profile: "list",
			context: "telemetryLivenessPulse",
		})
		return rows.reduce((total, row) => total + row.count, 0)
	}).pipe(Effect.orElseSucceed(() => null))

/**
 * Prove telemetry is still flowing for a subject before its silence is allowed
 * to mean anything. Never fails — an unprovable probe is a veto, not an error.
 */
export const probeLiveness: (input: LivenessProbeInput) => Effect.Effect<LivenessVerdict, never> =
	Effect.fn("telemetry.liveness")(function* (input) {
		const { warehouse, tenant, serviceNames } = input
		const { windowStartMs, windowEndMs, baselineStartMs, baselineEndMs } = input

		const result =
			serviceNames.length === 0
				? verdictForOrgTotals(
						...(yield* Effect.all(
							[
								probeOrgWindow(warehouse, tenant, windowStartMs, windowEndMs),
								probeOrgWindow(warehouse, tenant, baselineStartMs, baselineEndMs),
							],
							{ concurrency: 2 },
						)),
					)
				: verdictForServiceTotals(
						yield* Effect.forEach(
							serviceNames,
							(serviceName): Effect.Effect<ServiceWindowPair, never> =>
								Effect.all(
									[
										probeServiceWindow(warehouse, tenant, serviceName, windowStartMs, windowEndMs),
										probeServiceWindow(
											warehouse,
											tenant,
											serviceName,
											baselineStartMs,
											baselineEndMs,
										),
									],
									{ concurrency: 2 },
								),
							{ concurrency: 4 },
						),
					)

		yield* Effect.annotateCurrentSpan({
			"maple.liveness.data_flowing": result.dataFlowing,
			"maple.liveness.reason": result.reason,
			"maple.liveness.observed_count": result.observedCount,
			"maple.liveness.baseline_count": result.baselineCount,
			...(result.ratio != null ? { "maple.liveness.volume_ratio": result.ratio } : {}),
			...(result.samplingDelta != null
				? { "maple.liveness.sampling_delta": result.samplingDelta }
				: {}),
		})

		return result
	})

// ---------------------------------------------------------------------------
// Pure verdict logic
// ---------------------------------------------------------------------------

const verdict = (
	dataFlowing: boolean,
	reason: LivenessReason,
	observedCount: number,
	baselineCount: number,
	ratio: number | null,
	samplingDelta: number | null,
): LivenessVerdict => ({ dataFlowing, reason, observedCount, baselineCount, ratio, samplingDelta })

/** Org-wide pulse verdict. `null` on either side means the probe failed. */
export const verdictForOrgTotals = (
	observed: number | null,
	baseline: number | null,
): LivenessVerdict => {
	if (observed === null || baseline === null) return verdict(false, "probe_failed", 0, 0, null, null)
	// Nothing to compare against: the org was already dark before the incident,
	// so this probe can neither confirm nor deny a gap.
	if (baseline === 0) return verdict(true, "no_baseline", observed, baseline, null, null)
	if (observed === 0) return verdict(false, "no_data", observed, baseline, 0, null)

	const ratio = observed / baseline
	if (ratio < LIVENESS_MIN_VOLUME_RATIO) {
		return verdict(false, "volume_collapsed", observed, baseline, ratio, null)
	}
	return verdict(true, "ok", observed, baseline, ratio, null)
}

/**
 * Per-service verdict. A single service going dark is a gap even when the other
 * services keep the totals healthy, so the per-service check runs before any
 * aggregation.
 */
export const verdictForServiceTotals = (
	perService: ReadonlyArray<ServiceWindowPair>,
): LivenessVerdict => {
	let observedRaw = 0
	let observedEst = 0
	let baselineRaw = 0
	let baselineEst = 0
	let wentDark = false

	for (const [observed, baseline] of perService) {
		if (observed === null || baseline === null) {
			return verdict(false, "probe_failed", 0, 0, null, null)
		}
		observedRaw += observed.spanCount
		observedEst += observed.estimatedSpanCount
		baselineRaw += baseline.spanCount
		baselineEst += baseline.estimatedSpanCount
		if (baseline.estimatedSpanCount > 0 && observed.estimatedSpanCount === 0) wentDark = true
	}

	if (baselineEst === 0) return verdict(true, "no_baseline", observedEst, baselineEst, null, null)
	if (wentDark) {
		return verdict(false, "no_data", observedEst, baselineEst, observedEst / baselineEst, null)
	}

	const ratio = observedEst / baselineEst
	const rawRatio = baselineRaw === 0 ? null : observedRaw / baselineRaw
	const samplingDelta = rawRatio === null ? null : Math.abs(rawRatio - ratio)

	// Checked before the volume floor: a sampler turned down looks exactly like a
	// traffic drop on raw counts, and the more specific diagnosis is the useful one.
	if (samplingDelta !== null && samplingDelta > LIVENESS_MAX_SAMPLING_DELTA) {
		return verdict(false, "sampling_changed", observedEst, baselineEst, ratio, samplingDelta)
	}
	if (ratio < LIVENESS_MIN_VOLUME_RATIO) {
		return verdict(false, "volume_collapsed", observedEst, baselineEst, ratio, samplingDelta)
	}
	return verdict(true, "ok", observedEst, baselineEst, ratio, samplingDelta)
}

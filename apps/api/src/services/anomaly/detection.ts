// ---------------------------------------------------------------------------
// Anomaly detection math — pure functions, no I/O.
//
// Baseline model: seasonal-naive. For the current hour-of-day `h`, the
// baseline samples are the finalized per-hour values for hours whose
// hour-of-day is in {h-1, h, h+1} over the trailing 7 days (≤21 samples; the
// in-progress hour is excluded). Robust bands via median/MAD with a sigma
// floor so constant series (MAD = 0) aren't hair-triggers.
//
// Error/latency breaches require statistical, ratio, absolute-delta, and
// volume guards. Throughput is deliberately stricter: only a near-total loss
// of a historically continuous traffic stream is service-health evidence.
// ---------------------------------------------------------------------------

import type { AnomalyIncidentSeverity, AnomalySensitivity, AnomalySignalType } from "@maple/domain/http"

export interface AnomalyEvaluation {
	readonly detectorKey: string
	readonly signalType: AnomalySignalType
	readonly serviceName: string
	readonly deploymentEnv: string
	readonly fingerprintHash: string | null
	readonly status: "breached" | "healthy" | "skipped"
	readonly value: number
	readonly baselineMedian: number
	readonly baselineSigma: number
	readonly threshold: number
	readonly sampleCount: number
	readonly severity: AnomalyIncidentSeverity
}

export interface SensitivityConfig {
	/** Robust z multiplier on the MAD-derived sigma. */
	readonly k: number
	/** Multiplicative ratio guard vs the baseline median. */
	readonly ratio: number
}

export const SENSITIVITY: Record<AnomalySensitivity, SensitivityConfig> = {
	low: { k: 6, ratio: 3.0 },
	normal: { k: 4, ratio: 2.0 },
	high: { k: 3, ratio: 1.5 },
}

/** Minimum sealed baseline samples before a series is evaluated at all. */
const MIN_BASELINE_SAMPLES = 6

const MAD_TO_SIGMA = 1.4826

export function median(values: readonly number[]): number {
	if (values.length === 0) return 0
	const sorted = [...values].sort((a, b) => a - b)
	const mid = Math.floor(sorted.length / 2)
	return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

export function mad(values: readonly number[], m: number): number {
	if (values.length === 0) return 0
	return median(values.map((v) => Math.abs(v - m)))
}

/**
 * MAD-derived sigma with absolute and relative floors. A constant series has
 * MAD = 0; without the floor any uptick would breach the statistical bound.
 */
export function robustSigma(
	values: readonly number[],
	m: number,
	epsilonAbs: number,
	epsilonRel: number,
): number {
	return Math.max(MAD_TO_SIGMA * mad(values, m), epsilonAbs, epsilonRel * m)
}

// ---------------------------------------------------------------------------
// Input shapes (rows already split into current vs baseline by the caller)
// ---------------------------------------------------------------------------

export interface GoldenSignalSeries {
	readonly serviceName: string
	readonly deploymentEnv: string
	/** Current partial-hour aggregates. */
	readonly current: { requestCount: number; errorCount: number; p95Ms: number }
	/** One entry per sealed matched hour. */
	readonly baseline: ReadonlyArray<{ requestCount: number; errorCount: number; p95Ms: number }>
}

export interface LogVolumeSeries {
	readonly serviceName: string
	readonly deploymentEnv: string
	readonly current: { errorLogCount: number }
	readonly baseline: ReadonlyArray<{ errorLogCount: number }>
}

export interface ErrorSpikeObservation {
	readonly fingerprintHash: string
	readonly serviceName: string
	readonly deploymentEnv: string
	/** Occurrences in the current 30-minute window. */
	readonly count: number
}

export interface ErrorSpikeBaseline {
	readonly totalCount: number
}

export interface DetectionConfig {
	readonly sensitivity: SensitivityConfig
	/** Minutes elapsed since the top of the current hour. */
	readonly elapsedMinutes: number
}

const detectorKeyFor = (signalType: AnomalySignalType, deploymentEnv: string, subject: string): string =>
	`${signalType}:${deploymentEnv}:${subject}`

const skipped = (
	signalType: AnomalySignalType,
	serviceName: string,
	deploymentEnv: string,
	value: number,
	sampleCount: number,
	fingerprintHash: string | null = null,
): AnomalyEvaluation => ({
	detectorKey: detectorKeyFor(signalType, deploymentEnv, fingerprintHash ?? serviceName),
	signalType,
	serviceName,
	deploymentEnv,
	fingerprintHash,
	status: "skipped",
	value,
	baselineMedian: 0,
	baselineSigma: 0,
	threshold: 0,
	sampleCount,
	severity: "warning",
})

// ---------------------------------------------------------------------------
// Golden signals
// ---------------------------------------------------------------------------

/** Minimum weighted request count in the current window before evaluating. */
const GOLDEN_MIN_VOLUME = 50
/** Throughput needs ≥10 elapsed minutes before its per-minute rate is stable. */
const RATE_MIN_ELAPSED_MINUTES = 10
/**
 * Minimum expected requests (baseline rate × elapsed minutes) before a
 * throughput drop is evaluable: until that many requests were expected, an
 * observed zero is indistinguishable from a normal quiet stretch.
 */
const THROUGHPUT_MIN_EXPECTED = 30
/**
 * A missing hourly aggregate means the service had no traffic in that hour;
 * it is not emitted as a zero-valued row. Require coverage across at least
 * two-thirds of the 21 matched baseline hours before treating a service as
 * continuously active and therefore eligible for outage detection.
 */
const THROUGHPUT_MIN_BASELINE_SAMPLES = 14
/** Only a near-total loss of an established traffic stream is a health issue. */
const THROUGHPUT_OUTAGE_FRACTION = 0.05

export function evaluateGoldenSignals(
	series: GoldenSignalSeries,
	config: DetectionConfig,
): AnomalyEvaluation[] {
	const { serviceName, deploymentEnv, current, baseline } = series
	const { k, ratio } = config.sensitivity
	const evaluations: AnomalyEvaluation[] = []

	const makeEval = (
		signalType: AnomalySignalType,
		value: number,
		m: number,
		sigma: number,
		threshold: number,
		breached: boolean,
		severity: AnomalyIncidentSeverity,
		sampleCount: number,
	): AnomalyEvaluation => ({
		detectorKey: detectorKeyFor(signalType, deploymentEnv, serviceName),
		signalType,
		serviceName,
		deploymentEnv,
		fingerprintHash: null,
		status: breached ? "breached" : "healthy",
		value,
		baselineMedian: m,
		baselineSigma: sigma,
		threshold,
		sampleCount,
		severity,
	})

	const insufficientBaseline = baseline.length < MIN_BASELINE_SAMPLES
	const currentCount = current.requestCount

	// --- Error rate -----------------------------------------------------------
	{
		const signal: AnomalySignalType = "error_rate"
		if (insufficientBaseline || currentCount < GOLDEN_MIN_VOLUME) {
			evaluations.push(
				skipped(
					signal,
					serviceName,
					deploymentEnv,
					currentCount > 0 ? current.errorCount / currentCount : 0,
					currentCount,
				),
			)
		} else {
			const rates = baseline.filter((b) => b.requestCount > 0).map((b) => b.errorCount / b.requestCount)
			if (rates.length < MIN_BASELINE_SAMPLES) {
				evaluations.push(skipped(signal, serviceName, deploymentEnv, 0, currentCount))
			} else {
				const value = current.errorCount / currentCount
				const m = median(rates)
				const sigma = robustSigma(rates, m, 0.005, 0.25)
				const threshold = Math.max(m + k * sigma, m * ratio, m + 0.02, 0.01)
				const breached = value > threshold
				const severity: AnomalyIncidentSeverity =
					value >= Math.max(3 * m, m + 0.1) ? "critical" : "warning"
				evaluations.push(
					makeEval(signal, value, m, sigma, threshold, breached, severity, currentCount),
				)
			}
		}
	}

	// --- p95 latency -----------------------------------------------------------
	{
		const signal: AnomalySignalType = "latency_p95"
		if (insufficientBaseline || currentCount < GOLDEN_MIN_VOLUME) {
			evaluations.push(skipped(signal, serviceName, deploymentEnv, current.p95Ms, currentCount))
		} else {
			const p95s = baseline.filter((b) => b.requestCount > 0).map((b) => b.p95Ms)
			if (p95s.length < MIN_BASELINE_SAMPLES) {
				evaluations.push(skipped(signal, serviceName, deploymentEnv, current.p95Ms, currentCount))
			} else {
				const value = current.p95Ms
				const m = median(p95s)
				const sigma = robustSigma(p95s, m, 5, 0.1)
				const threshold = Math.max(m + k * sigma, m * (1 + (ratio - 1) / 2), m + 50)
				const breached = value > threshold
				const severity: AnomalyIncidentSeverity = m > 0 && value >= 4 * m ? "critical" : "warning"
				evaluations.push(
					makeEval(signal, value, m, sigma, threshold, breached, severity, currentCount),
				)
			}
		}
	}

	// --- Throughput (drops only) -----------------------------------------------
	{
		const signal: AnomalySignalType = "throughput"
		const ratePerMin = config.elapsedMinutes > 0 ? currentCount / config.elapsedMinutes : currentCount
		if (config.elapsedMinutes < RATE_MIN_ELAPSED_MINUTES) {
			evaluations.push(skipped(signal, serviceName, deploymentEnv, ratePerMin, currentCount))
		} else {
			const rates = baseline.map((b) => b.requestCount / 60)
			const m = median(rates)
			const sigma = robustSigma(rates, m, 0.5, 0.1)
			const threshold = m * THROUGHPUT_OUTAGE_FRACTION
			const hasContinuousBaseline = baseline.length >= THROUGHPUT_MIN_BASELINE_SAMPLES
			const hasEnoughExpectedTraffic = m * config.elapsedMinutes >= THROUGHPUT_MIN_EXPECTED
			const breached = hasContinuousBaseline && hasEnoughExpectedTraffic && ratePerMin < threshold

			// Once the current window is mature, an ineligible series is healthy for
			// this signal—not skipped. This lets stale incidents created by the old,
			// overly broad drop detector recover instead of freezing open forever.
			evaluations.push(
				makeEval(signal, ratePerMin, m, sigma, threshold, breached, "warning", currentCount),
			)
		}
	}

	return evaluations
}

// ---------------------------------------------------------------------------
// Log volume (error-class severities)
// ---------------------------------------------------------------------------

const LOG_MIN_VOLUME = 30

export function evaluateLogVolume(series: LogVolumeSeries, config: DetectionConfig): AnomalyEvaluation {
	const signal: AnomalySignalType = "log_volume"
	const { serviceName, deploymentEnv, current, baseline } = series
	const { k, ratio } = config.sensitivity

	const ratePerMin =
		config.elapsedMinutes > 0 ? current.errorLogCount / config.elapsedMinutes : current.errorLogCount

	if (
		baseline.length < MIN_BASELINE_SAMPLES ||
		config.elapsedMinutes < RATE_MIN_ELAPSED_MINUTES ||
		current.errorLogCount < LOG_MIN_VOLUME
	) {
		return skipped(signal, serviceName, deploymentEnv, ratePerMin, current.errorLogCount)
	}

	const rates = baseline.map((b) => b.errorLogCount / 60)
	const m = median(rates)
	const sigma = robustSigma(rates, m, 0.5, 0.25)
	const threshold = Math.max(m + k * sigma, m * ratio, m + LOG_MIN_VOLUME / 60)
	const breached = ratePerMin > threshold

	return {
		detectorKey: detectorKeyFor(signal, deploymentEnv, serviceName),
		signalType: signal,
		serviceName,
		deploymentEnv,
		fingerprintHash: null,
		status: breached ? "breached" : "healthy",
		value: ratePerMin,
		baselineMedian: m,
		baselineSigma: sigma,
		threshold,
		sampleCount: current.errorLogCount,
		severity: "warning",
	}
}

// ---------------------------------------------------------------------------
// Error fingerprint spikes (Poisson-flavored — counts are small)
// ---------------------------------------------------------------------------

/** Half-hour windows in 7 days. */
const HALF_HOURS_PER_WEEK = 336
export const ERROR_SPIKE_MIN_COUNT = 10
/** Fingerprints younger than this stay with ErrorsService first_seen handling. */
const SPIKE_MIN_ISSUE_AGE_MS = 24 * 60 * 60 * 1000

export interface ErrorSpikeConfig {
	readonly sensitivity: SensitivityConfig
	/** firstSeenAt (epoch ms) per fingerprintHash, from error_issues. */
	readonly issueFirstSeenAt: ReadonlyMap<string, number>
	readonly nowMs: number
}

export function evaluateErrorSpike(
	observation: ErrorSpikeObservation,
	baseline: ErrorSpikeBaseline | undefined,
	config: ErrorSpikeConfig,
): AnomalyEvaluation {
	const signal: AnomalySignalType = "error_spike"
	const { fingerprintHash, serviceName, deploymentEnv, count } = observation

	const firstSeenAt = config.issueFirstSeenAt.get(fingerprintHash)
	const tooYoung = firstSeenAt !== undefined && config.nowMs - firstSeenAt < SPIKE_MIN_ISSUE_AGE_MS
	if (baseline === undefined || tooYoung || count < ERROR_SPIKE_MIN_COUNT) {
		return skipped(signal, serviceName, deploymentEnv, count, count, fingerprintHash)
	}

	// Spike ratio guard scales with sensitivity: 4× at normal (ratio 2.0).
	const ratioGuard = config.sensitivity.ratio * 2
	const lambda = baseline.totalCount / HALF_HOURS_PER_WEEK
	const threshold = Math.max(
		lambda + Math.max(3 * Math.sqrt(lambda), ERROR_SPIKE_MIN_COUNT),
		lambda * ratioGuard,
		ERROR_SPIKE_MIN_COUNT,
	)
	const breached = count > threshold

	return {
		detectorKey: detectorKeyFor(signal, deploymentEnv, fingerprintHash),
		signalType: signal,
		serviceName,
		deploymentEnv,
		fingerprintHash,
		status: breached ? "breached" : "healthy",
		value: count,
		baselineMedian: lambda,
		baselineSigma: Math.sqrt(Math.max(lambda, 1)),
		threshold,
		sampleCount: count,
		severity: count >= threshold * 3 ? "critical" : "warning",
	}
}

/**
 * Recovery evaluation for a fingerprint that already owns an open incident.
 *
 * The absolute event floor is an opening/noise guard, not evidence that an
 * existing incident is still firing. Once the fingerprint drops below the
 * floor (including disappearing from the current query entirely), emit a
 * healthy evaluation so normal hysteresis can resolve it.
 */
export function healthyErrorSpikeRecovery(
	observation: ErrorSpikeObservation,
	baselineMedian: number,
	config: Pick<ErrorSpikeConfig, "sensitivity">,
): AnomalyEvaluation {
	const ratioGuard = config.sensitivity.ratio * 2
	const threshold = Math.max(
		baselineMedian + Math.max(3 * Math.sqrt(baselineMedian), ERROR_SPIKE_MIN_COUNT),
		baselineMedian * ratioGuard,
		ERROR_SPIKE_MIN_COUNT,
	)

	return {
		detectorKey: detectorKeyFor("error_spike", observation.deploymentEnv, observation.fingerprintHash),
		signalType: "error_spike",
		serviceName: observation.serviceName,
		deploymentEnv: observation.deploymentEnv,
		fingerprintHash: observation.fingerprintHash,
		status: "healthy",
		value: observation.count,
		baselineMedian,
		baselineSigma: Math.sqrt(Math.max(baselineMedian, 1)),
		threshold,
		sampleCount: observation.count,
		severity: "warning",
	}
}

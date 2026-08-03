import { describe, expect, it } from "vitest"
import {
	evaluateErrorSpike,
	evaluateGoldenSignals,
	evaluateLogVolume,
	healthyErrorSpikeRecovery,
	mad,
	median,
	robustSigma,
	SENSITIVITY,
	type GoldenSignalSeries,
} from "./detection"

const normalConfig = { sensitivity: SENSITIVITY.normal, elapsedMinutes: 30 }

const goldenBaseline = (overrides?: Partial<{ requestCount: number; errorCount: number; p95Ms: number }>) =>
	Array.from({ length: 21 }, () => ({
		requestCount: 6000,
		errorCount: 60, // 1% error rate
		p95Ms: 200,
		...overrides,
	}))

const goldenSeries = (
	current: GoldenSignalSeries["current"],
	baseline = goldenBaseline(),
): GoldenSignalSeries => ({
	serviceName: "api",
	deploymentEnv: "production",
	current,
	baseline,
})

const byKey = (evaluations: ReturnType<typeof evaluateGoldenSignals>, signal: string) => {
	const found = evaluations.find((e) => e.signalType === signal)
	if (!found) throw new Error(`missing evaluation for ${signal}`)
	return found
}

describe("median/mad/robustSigma", () => {
	it("computes the median of odd and even sets", () => {
		expect(median([3, 1, 2])).toBe(2)
		expect(median([4, 1, 2, 3])).toBe(2.5)
		expect(median([])).toBe(0)
	})

	it("computes MAD around the median", () => {
		expect(mad([1, 1, 2, 2, 4, 6, 9], 2)).toBe(1)
	})

	it("floors sigma for constant series", () => {
		// MAD = 0 → sigma must come from the floors, not collapse to 0.
		expect(robustSigma([5, 5, 5, 5], 5, 0.1, 0.05)).toBeCloseTo(0.25)
		expect(robustSigma([5, 5, 5, 5], 5, 0.5, 0.05)).toBeCloseTo(0.5)
	})
})

describe("evaluateGoldenSignals — error rate", () => {
	it("breaches on a 10x error-rate spike", () => {
		const evals = evaluateGoldenSignals(
			goldenSeries({ requestCount: 3000, errorCount: 300, p95Ms: 200 }), // 10%
			normalConfig,
		)
		const e = byKey(evals, "error_rate")
		expect(e.status).toBe("breached")
		// Critical needs an absolute floor too (m + 0.10 = 11%); 10% stays warning.
		expect(e.severity).toBe("warning")
		expect(e.detectorKey).toBe("error_rate:production:api")
	})

	it("flags critical past the absolute severity floor", () => {
		const evals = evaluateGoldenSignals(
			goldenSeries({ requestCount: 3000, errorCount: 450, p95Ms: 200 }), // 15%
			normalConfig,
		)
		const e = byKey(evals, "error_rate")
		expect(e.status).toBe("breached")
		expect(e.severity).toBe("critical")
	})

	it("skips under the volume floor even with a huge rate", () => {
		const evals = evaluateGoldenSignals(
			goldenSeries({ requestCount: 20, errorCount: 18, p95Ms: 200 }),
			normalConfig,
		)
		expect(byKey(evals, "error_rate").status).toBe("skipped")
	})

	it("stays healthy on a tiny uptick over a constant baseline (sigma floor)", () => {
		const evals = evaluateGoldenSignals(
			goldenSeries({ requestCount: 3000, errorCount: 45, p95Ms: 200 }), // 1.5% vs 1%
			normalConfig,
		)
		expect(byKey(evals, "error_rate").status).toBe("healthy")
	})

	it("skips when the baseline has too few samples", () => {
		const evals = evaluateGoldenSignals(
			goldenSeries({ requestCount: 3000, errorCount: 300, p95Ms: 200 }, goldenBaseline().slice(0, 4)),
			normalConfig,
		)
		expect(byKey(evals, "error_rate").status).toBe("skipped")
	})
})

describe("evaluateGoldenSignals — p95 latency", () => {
	it("is robust to one outlier hour in the baseline", () => {
		const baseline = goldenBaseline()
		baseline[3] = { ...baseline[3]!, p95Ms: 5000 } // single bad hour
		const evals = evaluateGoldenSignals(
			goldenSeries({ requestCount: 3000, errorCount: 30, p95Ms: 220 }, baseline),
			normalConfig,
		)
		expect(byKey(evals, "latency_p95").status).toBe("healthy")
	})

	it("breaches on a sustained 2x p95 regression", () => {
		const evals = evaluateGoldenSignals(
			goldenSeries({ requestCount: 3000, errorCount: 30, p95Ms: 450 }),
			normalConfig,
		)
		const e = byKey(evals, "latency_p95")
		expect(e.status).toBe("breached")
		expect(e.severity).toBe("warning")
	})

	it("flags critical at 4x baseline", () => {
		const evals = evaluateGoldenSignals(
			goldenSeries({ requestCount: 3000, errorCount: 30, p95Ms: 900 }),
			normalConfig,
		)
		expect(byKey(evals, "latency_p95").severity).toBe("critical")
	})
})

describe("evaluateGoldenSignals — throughput", () => {
	it("skips early in the hour", () => {
		const evals = evaluateGoldenSignals(goldenSeries({ requestCount: 100, errorCount: 0, p95Ms: 200 }), {
			sensitivity: SENSITIVITY.normal,
			elapsedMinutes: 5,
		})
		expect(byKey(evals, "throughput").status).toBe("skipped")
	})

	it("stays healthy on a large but non-outage traffic reduction", () => {
		// Baseline 6000/h = 100/min; current 600 over 20min = 30/min.
		const evals = evaluateGoldenSignals(goldenSeries({ requestCount: 600, errorCount: 6, p95Ms: 200 }), {
			sensitivity: SENSITIVITY.normal,
			elapsedMinutes: 20,
		})
		expect(byKey(evals, "throughput").status).toBe("healthy")
	})

	it("keeps near-idle services healthy", () => {
		const evals = evaluateGoldenSignals(
			goldenSeries(
				{ requestCount: 0, errorCount: 0, p95Ms: 0 },
				goldenBaseline({ requestCount: 30, errorCount: 0 }), // 0.5/min baseline
			),
			normalConfig,
		)
		expect(byKey(evals, "throughput").status).toBe("healthy")
	})

	it("keeps low-rate services healthy when too few requests were expected", () => {
		// Baseline 72/h = 1.2/min; 20 elapsed minutes → 24 expected < 30.
		const evals = evaluateGoldenSignals(
			goldenSeries(
				{ requestCount: 0, errorCount: 0, p95Ms: 0 },
				goldenBaseline({ requestCount: 72, errorCount: 0 }),
			),
			{ sensitivity: SENSITIVITY.normal, elapsedMinutes: 20 },
		)
		expect(byKey(evals, "throughput").status).toBe("healthy")
	})

	it("never evaluates services whose hourly expectation stays under the floor", () => {
		// 24/h = 0.4/min never reaches 30 expected within an hour.
		const evals = evaluateGoldenSignals(
			goldenSeries(
				{ requestCount: 0, errorCount: 0, p95Ms: 0 },
				goldenBaseline({ requestCount: 24, errorCount: 0 }),
			),
			{ sensitivity: SENSITIVITY.normal, elapsedMinutes: 59 },
		)
		expect(byKey(evals, "throughput").status).toBe("healthy")
	})

	it("does not treat an intermittent baseline as an always-on service", () => {
		const intermittent = goldenBaseline().slice(0, 7)
		const evals = evaluateGoldenSignals(
			goldenSeries({ requestCount: 0, errorCount: 0, p95Ms: 0 }, intermittent),
			normalConfig,
		)
		expect(byKey(evals, "throughput").status).toBe("healthy")
	})

	// Rates 5/10/40 per minute exercise a highly variable but well-covered
	// baseline. Even here, only a near-total outage should affect health.
	const highVarianceBaseline = [
		...Array.from({ length: 7 }, () => ({ requestCount: 300, errorCount: 0, p95Ms: 200 })),
		...Array.from({ length: 7 }, () => ({ requestCount: 600, errorCount: 0, p95Ms: 200 })),
		...Array.from({ length: 7 }, () => ({ requestCount: 2400, errorCount: 0, p95Ms: 200 })),
	]

	it("stays healthy when a variable service still has meaningful traffic", () => {
		// 25 requests in 30min = 0.83/min, above the 5% outage threshold of
		// 0.5/min. This is quieter than usual, but it is not an outage.
		const evals = evaluateGoldenSignals(
			goldenSeries({ requestCount: 25, errorCount: 0, p95Ms: 200 }, highVarianceBaseline),
			normalConfig,
		)
		expect(byKey(evals, "throughput").status).toBe("healthy")
	})

	it("breaches on a near-total outage", () => {
		const evals = evaluateGoldenSignals(
			goldenSeries({ requestCount: 3, errorCount: 0, p95Ms: 200 }, highVarianceBaseline),
			normalConfig,
		)
		expect(byKey(evals, "throughput").status).toBe("breached")
	})

	it("stays fireable on high-variance series with a non-negative outage threshold", () => {
		const noisy = Array.from({ length: 21 }, (_, i) => ({
			requestCount: i % 2 === 0 ? 600 : 12000,
			errorCount: 0,
			p95Ms: 200,
		}))
		const evals = evaluateGoldenSignals(
			goldenSeries({ requestCount: 0, errorCount: 0, p95Ms: 0 }, noisy),
			{ sensitivity: SENSITIVITY.low, elapsedMinutes: 20 }, // k=6 worst case
		)
		const e = byKey(evals, "throughput")
		expect(e.threshold).toBeGreaterThan(0)
		expect(e.status).toBe("breached")
	})
})

describe("evaluateLogVolume", () => {
	const logSeries = (errorLogCount: number, baselineCount = 120) => ({
		serviceName: "api",
		deploymentEnv: "production",
		current: { errorLogCount },
		baseline: Array.from({ length: 21 }, () => ({ errorLogCount: baselineCount })),
	})

	it("breaches on a big error-log burst", () => {
		// Baseline 120/h = 2/min; current 600 in 30min = 20/min.
		const e = evaluateLogVolume(logSeries(600), normalConfig)
		expect(e.status).toBe("breached")
	})

	it("skips under the absolute event floor", () => {
		const e = evaluateLogVolume(logSeries(20, 1), normalConfig)
		expect(e.status).toBe("skipped")
	})

	it("stays healthy within bands", () => {
		const e = evaluateLogVolume(logSeries(70), normalConfig)
		expect(e.status).toBe("healthy")
	})
})

describe("evaluateErrorSpike", () => {
	const nowMs = Date.parse("2026-06-11T12:00:00Z")
	const oldIssue = new Map([["fp1", nowMs - 7 * 24 * 60 * 60 * 1000]])
	const spikeConfig = { sensitivity: SENSITIVITY.normal, issueFirstSeenAt: oldIssue, nowMs }
	const observation = (count: number) => ({
		fingerprintHash: "fp1",
		serviceName: "api",
		deploymentEnv: "production",
		count,
	})

	it("breaches when a quiet fingerprint bursts past the Poisson floor", () => {
		// λ = 336/336 = 1 per half hour; threshold = max(1+10, 4, 10) = 11.
		const e = evaluateErrorSpike(observation(40), { totalCount: 336 }, spikeConfig)
		expect(e.status).toBe("breached")
	})

	it("respects the minimum count floor", () => {
		const e = evaluateErrorSpike(observation(8), { totalCount: 10 }, spikeConfig)
		expect(e.status).toBe("skipped")
	})

	it("emits a healthy recovery value below the opening floor for an existing incident", () => {
		const e = healthyErrorSpikeRecovery(observation(8), 10 / 336, spikeConfig)
		expect(e).toMatchObject({
			detectorKey: "error_spike:production:fp1",
			status: "healthy",
			value: 8,
			sampleCount: 8,
		})
		expect(e.threshold).toBeGreaterThanOrEqual(10)
	})

	it("emits a zero-valued recovery when an open fingerprint disappears", () => {
		const e = healthyErrorSpikeRecovery(observation(0), 1, spikeConfig)
		expect(e.status).toBe("healthy")
		expect(e.value).toBe(0)
		expect(e.baselineMedian).toBe(1)
	})

	it("stays healthy when a chatty fingerprint is at its usual volume", () => {
		// λ = 6720/336 = 20; current 25 < max(20+13.4, 80) = 80.
		const e = evaluateErrorSpike(observation(25), { totalCount: 6720 }, spikeConfig)
		expect(e.status).toBe("healthy")
	})

	it("suppresses fingerprints younger than 24h (first_seen territory)", () => {
		const young = new Map([["fp1", nowMs - 60 * 60 * 1000]])
		const e = evaluateErrorSpike(
			observation(100),
			{ totalCount: 336 },
			{ ...spikeConfig, issueFirstSeenAt: young },
		)
		expect(e.status).toBe("skipped")
	})

	it("skips when no baseline row exists", () => {
		const e = evaluateErrorSpike(observation(100), undefined, spikeConfig)
		expect(e.status).toBe("skipped")
	})
})

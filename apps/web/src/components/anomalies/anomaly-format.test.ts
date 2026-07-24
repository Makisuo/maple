import { describe, expect, it } from "vitest"
import type { AnomalyIncidentDocument } from "@maple/domain/http"
import {
	anomalyAffectsServiceHealth,
	deviation,
	formatSignalValue,
	isStaleOpenIncident,
	SEVERITY_TONE,
	severityToneFor,
	SIGNAL_LABEL,
} from "./anomaly-format"

const incident = (
	overrides: Partial<
		Pick<AnomalyIncidentDocument, "signalType" | "lastObservedValue" | "baselineMedian" | "baselineSigma">
	>,
) => ({
	signalType: "error_rate" as AnomalyIncidentDocument["signalType"],
	lastObservedValue: 0,
	baselineMedian: 0,
	baselineSigma: 0,
	...overrides,
})

describe("deviation", () => {
	it("labels throughput as a percent of baseline", () => {
		const full = deviation(
			incident({
				signalType: "throughput",
				lastObservedValue: 0,
				baselineMedian: 1.2,
				baselineSigma: 1,
			}),
		)
		expect(full.kind).toBe("percent")
		expect(full.label).toBe("−100%")

		const partial = deviation(
			incident({
				signalType: "throughput",
				lastObservedValue: 8.5,
				baselineMedian: 49.7,
				baselineSigma: 70,
			}),
		)
		expect(partial.label).toBe("−83%")
	})

	it("falls back to σ for throughput with no baseline", () => {
		const dev = deviation(
			incident({ signalType: "throughput", lastObservedValue: 0, baselineMedian: 0, baselineSigma: 0 }),
		)
		expect(dev.label).toBe("new signal")
	})

	it("keeps σ labels in the readable range", () => {
		const dev = deviation(
			incident({ lastObservedValue: 0.05, baselineMedian: 0.008, baselineSigma: 0.01 }),
		)
		expect(dev.kind).toBe("sigma")
		expect(dev.label).toBe("+4.2σ")
	})

	it("switches to a ratio past the σ readability limit", () => {
		// The "+99.4σ" production case: log volume 332.9/min vs 2.6/min baseline.
		const dev = deviation(
			incident({
				signalType: "log_volume",
				lastObservedValue: 332.9,
				baselineMedian: 2.6,
				baselineSigma: 3.32,
			}),
		)
		expect(dev.kind).toBe("ratio")
		expect(dev.label).toBe("128× baseline")
	})

	it("caps absurd ratios", () => {
		const dev = deviation(incident({ lastObservedValue: 100_000, baselineMedian: 1, baselineSigma: 1 }))
		expect(dev.label).toBe("999× baseline")
	})

	it("labels brand-new signals", () => {
		const dev = deviation(incident({ lastObservedValue: 50 }))
		expect(dev.kind).toBe("new")
		expect(dev.label).toBe("new signal")
	})

	it("falls back to a ratio when σ is zero but a baseline exists", () => {
		const dev = deviation(incident({ lastObservedValue: 5, baselineMedian: 2.5, baselineSigma: 0 }))
		expect(dev.kind).toBe("ratio")
		expect(dev.sigma).toBeNull()
		expect(dev.ratio).toBe(2)
		expect(dev.label).toBe("2.0× baseline")
	})

	it("renders negative σ with the U+2212 minus sign", () => {
		const dev = deviation(
			incident({ lastObservedValue: 0.002, baselineMedian: 0.01, baselineSigma: 0.002 }),
		)
		expect(dev.kind).toBe("sigma")
		expect(dev.sigma).toBeCloseTo(-4)
		// U+2212 minus, matching the percent branch — not the ASCII hyphen.
		expect(dev.label).toBe("−4.0σ")
		expect(dev.label).not.toContain("-")
	})
})

describe("formatSignalValue", () => {
	it("formats error rate as a percent", () => {
		expect(formatSignalValue("error_rate", 0.123)).toBe("12.3%")
		expect(formatSignalValue("error_rate", 0)).toBe("0.0%")
	})

	it("formats latency in ms below one second and switches to seconds at 1000ms", () => {
		expect(formatSignalValue("latency_p95", 850)).toBe("850ms")
		expect(formatSignalValue("latency_p95", 999.4)).toBe("999ms")
		expect(formatSignalValue("latency_p95", 1000)).toBe("1.00s")
		expect(formatSignalValue("latency_p95", 2500)).toBe("2.50s")
	})

	it("formats throughput as a per-minute rate", () => {
		expect(formatSignalValue("throughput", 12.34)).toBe("12.3/min")
	})

	it("formats log volume as a per-minute rate", () => {
		expect(formatSignalValue("log_volume", 0)).toBe("0.0/min")
	})

	it("formats error-frequency increases as a 30-minute count", () => {
		expect(formatSignalValue("error_spike", 41.6)).toBe("42 occurrences / 30m")
	})
})

describe("error-frequency incident semantics", () => {
	const nowMs = Date.parse("2026-07-23T12:00:00Z")
	const openIncident = {
		status: "open" as const,
		signalType: "error_rate" as const,
		lastTriggeredAt: "2026-07-23T11:30:00.000Z",
	}

	it("uses an explicit user-facing label while preserving the internal signal", () => {
		expect(SIGNAL_LABEL.error_spike).toBe("Error frequency increase")
	})

	it("marks open incidents stale after one hour", () => {
		expect(isStaleOpenIncident(openIncident, nowMs)).toBe(false)
		expect(
			isStaleOpenIncident({ ...openIncident, lastTriggeredAt: "2026-07-23T10:59:59.999Z" }, nowMs),
		).toBe(true)
		expect(
			isStaleOpenIncident(
				{ ...openIncident, status: "resolved", lastTriggeredAt: "2026-07-01T00:00:00.000Z" },
				nowMs,
			),
		).toBe(false)
	})

	it("keeps error-frequency and stale incidents out of service health", () => {
		expect(anomalyAffectsServiceHealth(openIncident, nowMs)).toBe(true)
		expect(anomalyAffectsServiceHealth({ ...openIncident, signalType: "error_spike" }, nowMs)).toBe(false)
		expect(
			anomalyAffectsServiceHealth(
				{ ...openIncident, lastTriggeredAt: "2026-07-23T10:00:00.000Z" },
				nowMs,
			),
		).toBe(false)
	})
})

describe("severityToneFor", () => {
	it("uses the severity tone for open incidents", () => {
		expect(severityToneFor({ status: "open", severity: "critical" })).toBe(SEVERITY_TONE.critical)
		expect(severityToneFor({ status: "open", severity: "warning" })).toBe(SEVERITY_TONE.warning)
	})

	it("uses the resolved tone for non-open incidents regardless of severity", () => {
		expect(severityToneFor({ status: "resolved", severity: "critical" })).toBe(SEVERITY_TONE.resolved)
		expect(severityToneFor({ status: "resolved", severity: "warning" })).toBe(SEVERITY_TONE.resolved)
	})
})

import { describe, expect, it } from "vitest"
import {
	MAX_VERIFICATION_ATTEMPTS,
	VERIFICATION_TARGET_OCCURRENCES,
	verificationBandFor,
	verificationVerdictAutoCloses,
	verificationWindowMs,
} from "./fix-verification"
import type { IssueSeverity } from "./errors"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const SEVERITIES: ReadonlyArray<IssueSeverity | null> = ["critical", "high", "medium", "low", null]

describe("verificationWindowMs", () => {
	it("derives the window from the rate when it lands inside the band", () => {
		// 5/hour → 20 occurrences would take 4 hours, which is inside high's [1h, 3d].
		expect(verificationWindowMs({ severity: "high", ratePerHour: 5 })).toBe(4 * HOUR)
	})

	it("clamps a high-volume error up to the band floor", () => {
		// ~10k/day is ~417/hour → derived window is under 3 minutes, well below
		// critical's 30-minute floor.
		const window = verificationWindowMs({ severity: "critical", ratePerHour: 10_000 / 24 })
		expect(window).toBe(30 * MINUTE)
	})

	it("clamps a rare error down to the band ceiling", () => {
		// ~3/week is ~0.018/hour → derived window is over a month, past low's 14 days.
		const window = verificationWindowMs({ severity: "low", ratePerHour: 3 / (7 * 24) })
		expect(window).toBe(14 * DAY)
	})

	it("waits the band maximum when there is no usable rate", () => {
		for (const severity of SEVERITIES) {
			const band = verificationBandFor(severity)
			expect(verificationWindowMs({ severity, ratePerHour: 0 })).toBe(band.maxMs)
			expect(verificationWindowMs({ severity, ratePerHour: -1 })).toBe(band.maxMs)
			expect(verificationWindowMs({ severity, ratePerHour: Number.NaN })).toBe(band.maxMs)
			expect(verificationWindowMs({ severity, ratePerHour: Number.POSITIVE_INFINITY })).toBe(band.maxMs)
		}
	})

	it("always returns a finite window inside the severity band", () => {
		const rates = [0, 0.001, 0.5, 1, 12, 417, 100_000]
		for (const severity of SEVERITIES) {
			const band = verificationBandFor(severity)
			for (const ratePerHour of rates) {
				const window = verificationWindowMs({ severity, ratePerHour })
				expect(Number.isFinite(window)).toBe(true)
				expect(window).toBeGreaterThanOrEqual(band.minMs)
				expect(window).toBeLessThanOrEqual(band.maxMs)
			}
		}
	})

	it("waits longer for a rarer error at the same severity", () => {
		const busy = verificationWindowMs({ severity: "medium", ratePerHour: 20 })
		const quiet = verificationWindowMs({ severity: "medium", ratePerHour: 1 })
		expect(quiet).toBeGreaterThan(busy)
	})

	it("treats a null severity as low", () => {
		expect(verificationBandFor(null)).toEqual(verificationBandFor("low"))
		expect(verificationWindowMs({ severity: null, ratePerHour: 2 })).toBe(
			verificationWindowMs({ severity: "low", ratePerHour: 2 }),
		)
	})

	it("targets the configured occurrence count", () => {
		// One per hour means the derivation asks for exactly TARGET hours, which
		// medium's band ([4h, 7d]) leaves untouched.
		expect(verificationWindowMs({ severity: "medium", ratePerHour: 1 })).toBe(
			VERIFICATION_TARGET_OCCURRENCES * HOUR,
		)
	})
})

describe("verificationBandFor", () => {
	it("gives more urgent severities a lower ceiling", () => {
		expect(verificationBandFor("critical").maxMs).toBeLessThan(verificationBandFor("high").maxMs)
		expect(verificationBandFor("high").maxMs).toBeLessThan(verificationBandFor("medium").maxMs)
		expect(verificationBandFor("medium").maxMs).toBeLessThan(verificationBandFor("low").maxMs)
	})

	it("keeps every band non-empty", () => {
		for (const severity of SEVERITIES) {
			const band = verificationBandFor(severity)
			expect(band.minMs).toBeLessThan(band.maxMs)
			expect(band.minMs).toBeGreaterThan(0)
		}
	})
})

describe("verificationVerdictAutoCloses", () => {
	it("closes low, medium, and untriaged issues on its own", () => {
		expect(verificationVerdictAutoCloses("low")).toBe(true)
		expect(verificationVerdictAutoCloses("medium")).toBe(true)
		expect(verificationVerdictAutoCloses(null)).toBe(true)
	})

	it("leaves high and critical issues for a human", () => {
		expect(verificationVerdictAutoCloses("high")).toBe(false)
		expect(verificationVerdictAutoCloses("critical")).toBe(false)
	})
})

describe("MAX_VERIFICATION_ATTEMPTS", () => {
	it("allows exactly one retry", () => {
		expect(MAX_VERIFICATION_ATTEMPTS).toBe(2)
	})
})

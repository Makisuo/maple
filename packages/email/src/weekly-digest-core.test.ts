import { describe, expect, it } from "vitest"
import {
	computeDelta,
	deriveDigestStatus,
	DELTA_MIN_BASE,
	fmtDeltaAbs,
	fmtDeltaLabel,
	fmtScopeLabel,
	type Delta,
	type DigestService,
	type WeeklyDigestProps,
} from "./weekly-digest-core"
import { healthyDigestProps, multiEnvDigestProps, scopedDigestProps } from "./samples"

const pct = (value: number): Delta => ({ kind: "pct", value })

describe("computeDelta", () => {
	it("reports a first-ever week as new rather than +100%", () => {
		// The old `prev === 0 ? 100 : …` rule meant an org's very first digest
		// showed "↑ 100.0%" on every card.
		expect(computeDelta(1_000, 0)).toEqual({ kind: "new" })
	})

	it("reports a service that went silent as gone", () => {
		expect(computeDelta(0, 5_000)).toEqual({ kind: "gone" })
	})

	it("is none when both windows are empty", () => {
		expect(computeDelta(0, 0)).toEqual({ kind: "none" })
	})

	it("suppresses percentages off a base below the significance floor", () => {
		// 3 → 1,400 is a true +46,566% and a useless thing to put in an email.
		expect(computeDelta(1_400, 3)).toEqual({ kind: "none" })
		expect(computeDelta(1_400, DELTA_MIN_BASE.count)).toEqual({ kind: "pct", value: 1_300 })
	})

	it("scales the floor per unit", () => {
		expect(computeDelta(2_000_000, 500_000, "bytes")).toEqual({ kind: "none" })
		expect(computeDelta(2_000_000, 1_000_000, "bytes")).toEqual({ kind: "pct", value: 100 })
		expect(computeDelta(200, 100, "ms")).toEqual({ kind: "pct", value: 100 })
	})

	it("is none rather than Infinity for non-finite inputs", () => {
		expect(computeDelta(Number.NaN, 100)).toEqual({ kind: "none" })
		expect(computeDelta(100, Number.POSITIVE_INFINITY)).toEqual({ kind: "none" })
	})

	it("computes an ordinary week-over-week percentage", () => {
		expect(computeDelta(110, 100)).toEqual({ kind: "pct", value: 100 * (10 / 100) })
	})
})

describe("fmtDeltaAbs", () => {
	it("clamps runaway percentages instead of printing five figures", () => {
		expect(fmtDeltaAbs(45_000)).toBe(">999%")
		expect(fmtDeltaAbs(-45_000)).toBe(">999%")
		expect(fmtDeltaAbs(12.34)).toBe("12.3%")
	})
})

describe("fmtDeltaLabel", () => {
	it("renders each delta kind as prose", () => {
		expect(fmtDeltaLabel(pct(12.3))).toBe("↑ 12.3%")
		expect(fmtDeltaLabel(pct(-12.3))).toBe("↓ 12.3%")
		expect(fmtDeltaLabel({ kind: "new" })).toBe("new")
		expect(fmtDeltaLabel({ kind: "gone" })).toBe("gone")
		expect(fmtDeltaLabel({ kind: "none" })).toBe("—")
	})
})

describe("fmtScopeLabel", () => {
	it("is null for a whole-org digest", () => {
		expect(fmtScopeLabel({ environments: [], namespaces: [] })).toBeNull()
	})

	it("names namespaces before environments, and empty as unspecified", () => {
		expect(fmtScopeLabel({ environments: ["production"], namespaces: ["commerce"] })).toBe(
			"commerce · production",
		)
		expect(fmtScopeLabel({ environments: [""], namespaces: [] })).toBe("unspecified")
	})
})

const service = (over: Partial<DigestService>): DigestService => ({
	name: "svc",
	environment: "production",
	namespace: "",
	requests: 1_000,
	errorRate: 0,
	p95Ms: 100,
	requestsDelta: { kind: "none" },
	...over,
})

const props = (over: Partial<WeeklyDigestProps>): WeeklyDigestProps => ({
	...healthyDigestProps,
	services: [],
	environmentGroups: [],
	breakdown: { environments: [], namespaces: [] },
	summary: {
		requests: { value: 100_000, delta: { kind: "none" } },
		errors: { value: 0, delta: { kind: "none" } },
		p95Latency: { valueMs: 100, delta: { kind: "none" } },
		dataVolume: { valueBytes: 1_000, delta: { kind: "none" } },
	},
	...over,
})

describe("deriveDigestStatus", () => {
	it("keeps the three sample variants on their intended levels", () => {
		expect(deriveDigestStatus(healthyDigestProps).level).toBe("healthy")
		expect(deriveDigestStatus(multiEnvDigestProps).level).toBe("healthy")
		expect(deriveDigestStatus(scopedDigestProps).level).toBe("watch")
	})

	it("does not escalate on a non-percentage errors delta", () => {
		// `>= 25` used to be evaluated against a raw number where 100 meant "no
		// data last week", which escalated a quiet org to WATCH on its first send.
		const status = deriveDigestStatus(
			props({
				summary: {
					requests: { value: 100_000, delta: { kind: "new" } },
					errors: { value: 10, delta: { kind: "new" } },
					p95Latency: { valueMs: 100, delta: { kind: "new" } },
					dataVolume: { valueBytes: 1_000, delta: { kind: "new" } },
				},
			}),
		)
		expect(status.level).toBe("healthy")
	})

	it("names the environment in the biggest mover when the org runs several", () => {
		const status = deriveDigestStatus(
			props({
				services: [
					service({ name: "api", environment: "production", requestsDelta: pct(3) }),
					service({ name: "api", environment: "staging", requestsDelta: pct(-42) }),
				],
			}),
		)
		expect(status.biggestMover).toBe("api (staging) traffic down 42.0% WoW")
	})

	it("leaves the environment out when there is only one", () => {
		const status = deriveDigestStatus(
			props({
				services: [service({ name: "api", environment: "production", requestsDelta: pct(-42) })],
			}),
		)
		expect(status.biggestMover).toBe("api traffic down 42.0% WoW")
	})

	it("ignores unquantified deltas when ranking the biggest mover", () => {
		// A `new` service has no magnitude to rank by; the real swing must win.
		const status = deriveDigestStatus(
			props({
				services: [
					service({ name: "fresh", requestsDelta: { kind: "new" } }),
					service({ name: "swinger", requestsDelta: pct(-30) }),
				],
			}),
		)
		expect(status.biggestMover).toBe("swinger traffic down 30.0% WoW")
	})

	it("carries the scope into the subject so two scoped digests differ", () => {
		const scoped = deriveDigestStatus(
			props({ scope: { environments: ["production"], namespaces: ["commerce"] } }),
		)
		const unscoped = deriveDigestStatus(props({}))
		expect(scoped.subject).toContain("[commerce · production]")
		expect(unscoped.subject).not.toContain("[")
		expect(scoped.subject).not.toBe(unscoped.subject)
	})
})

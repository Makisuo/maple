import { describe, expect, it } from "vitest"
import { BillingCustomer, CatalogPlan, SpendLimits } from "@maple/domain/http"
import { Schema } from "effect"
import { baseDollarsFor, evaluateSpendLimits, featurePricingFor } from "./spend-limit-evaluation"

const decodeCustomer = Schema.decodeUnknownSync(BillingCustomer)
const decodePlans = Schema.decodeUnknownSync(Schema.Array(CatalogPlan))

const CYCLE_START = Date.UTC(2026, 6, 1)

// The Startup plan as it ships in autumn.config.ts.
const startupPlan = {
	id: "startup",
	name: "Startup",
	price: { amount: 39, interval: "month" },
	items: [
		{ featureId: "logs", included: 100, price: { amount: 0.3 } },
		{ featureId: "traces", included: 100, price: { amount: 0.3 } },
		{ featureId: "metrics", included: 100, price: { amount: 0.3 } },
		{ featureId: "browser_sessions", included: 5_000, price: { amount: 0.002 } },
	],
}

const customerOn = (planId: string, extra: Record<string, unknown> = {}) =>
	decodeCustomer({
		id: "org_1",
		subscriptions: [{ planId, status: "active" }],
		balances: {
			logs: { granted: 100 },
			traces: { granted: 100 },
			metrics: { granted: 100 },
			browser_sessions: { granted: 5_000 },
		},
		...extra,
	})

// $199.40 of spend: $39 base + 290 GB, 40 GB, 60 GB, and 21,700 sessions of overage.
const usage = {
	logs: { sum: 390 },
	traces: { sum: 140 },
	metrics: { sum: 160 },
	browser_sessions: { sum: 26_700 },
}

const limits = (overrides: Partial<SpendLimits> = {}) =>
	new SpendLimits({
		monthlyLimitCents: 30_000,
		enforcementMode: "pause",
		alertThresholdPercents: [80, 100],
		featureCaps: {},
		lastEvaluatedAt: null,
		evaluatedSpendCents: null,
		breachedAt: null,
		pausedAt: null,
		pausedFeatures: [],
		...overrides,
	})

const evaluate = (overrides: Parameters<typeof evaluateSpendLimits>[0] extends never ? never : Partial<Parameters<typeof evaluateSpendLimits>[0]>) =>
	evaluateSpendLimits({
		limits: limits(),
		customer: customerOn("startup"),
		plans: decodePlans([startupPlan]),
		usage,
		cycleStartMs: CYCLE_START,
		previousCycleStartMs: CYCLE_START,
		previouslyNotified: [],
		...overrides,
	})

describe("featurePricingFor / baseDollarsFor", () => {
	it("takes included from balances and rates from the catalog", () => {
		const features = featurePricingFor({
			customer: customerOn("startup"),
			plans: decodePlans([startupPlan]),
			usage,
		})

		expect(features.logs).toEqual({ used: 390, included: 100, ratePerUnit: 0.3, unlimited: false })
		expect(features.browser_sessions?.ratePerUnit).toBe(0.002)
	})

	it("adds active add-ons to the base price", () => {
		const withAddOn = decodeCustomer({
			id: "org_1",
			subscriptions: [
				{ planId: "startup", status: "active" },
				{ planId: "bringyourowncloud", status: "active", addOn: true },
			],
		})
		const plans = decodePlans([
			startupPlan,
			{ id: "bringyourowncloud", name: "BYOC", addOn: true, price: { amount: 99 }, items: [] },
		])

		expect(baseDollarsFor({ customer: withAddOn, plans })).toBe(138)
	})

	it("returns null for a legacy plan absent from the catalog", () => {
		// Unknown price, so the whole estimate must read as partial rather than
		// silently missing a base fee and looking under-limit.
		expect(
			baseDollarsFor({ customer: customerOn("legacy_pro"), plans: decodePlans([startupPlan]) }),
		).toBeNull()
	})
})

describe("evaluateSpendLimits", () => {
	it("prices the cycle and reports percent of the ceiling used", () => {
		const result = evaluate({})

		expect(result.spendCents).toBe(19_940)
		expect(result.overageByFeature.logs).toBe(8_700)
		expect(result.percentUsed).toBeCloseTo(66.47, 2)
		expect(result.breached).toBe(false)
		expect(result.partial).toBe(false)
	})

	it("breaches at or above the ceiling", () => {
		expect(evaluate({ limits: limits({ monthlyLimitCents: 19_940 }) }).breached).toBe(true)
		expect(evaluate({ limits: limits({ monthlyLimitCents: 19_941 }) }).breached).toBe(false)
	})

	it("never breaches without a ceiling, however large the spend", () => {
		const result = evaluate({
			limits: limits({ monthlyLimitCents: null, enforcementMode: "notify" }),
		})
		expect(result.breached).toBe(false)
		expect(result.percentUsed).toBeNull()
		expect(result.crossedThresholds).toEqual([])
	})

	it("reports crossed thresholds, and only un-notified ones as newly crossed", () => {
		// $199.40 against a $240 ceiling is 83%: past the 80% warning, short of 100%.
		const tight = limits({ monthlyLimitCents: 24_000 })

		const result = evaluate({ limits: tight, previouslyNotified: [] })
		expect(result.crossedThresholds).toEqual([80])
		expect(result.newlyCrossedThresholds).toEqual([80])

		const alreadySent = evaluate({ limits: tight, previouslyNotified: [80] })
		expect(alreadySent.crossedThresholds).toEqual([80])
		expect(alreadySent.newlyCrossedThresholds).toEqual([])
	})

	it("re-notifies a threshold after a cycle rollover", () => {
		// Crossing 80% in August must alert again even though July already did.
		const nextCycle = evaluate({
			limits: limits({ monthlyLimitCents: 24_000 }),
			previousCycleStartMs: Date.UTC(2026, 5, 1),
			previouslyNotified: [80],
		})
		expect(nextCycle.newlyCrossedThresholds).toEqual([80])
	})

	it("flags a partial estimate for a legacy plan — the caller must not pause on it", () => {
		const result = evaluate({ customer: customerOn("legacy_pro") })
		expect(result.partial).toBe(true)
	})

	it("reports per-feature caps independently of the spend ceiling", () => {
		const result = evaluate({
			limits: limits({ featureCaps: { logs: 300, traces: 500 } }),
		})
		// 390 GB of logs is over its 300 GB cap; 140 GB of traces is well under 500.
		expect(result.exceededCaps).toEqual(["logs"])
	})

	it("treats an unlimited feature as never in overage", () => {
		const unlimited = decodeCustomer({
			id: "org_1",
			subscriptions: [{ planId: "startup", status: "active" }],
			balances: { logs: { granted: 100, unlimited: true } },
		})
		const result = evaluate({ customer: unlimited })
		expect(result.overageByFeature.logs).toBe(0)
	})
})

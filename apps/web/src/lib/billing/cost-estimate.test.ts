import { describe, expect, it } from "vitest"
import type {
	BillingBalance,
	BillingCustomer,
	BillingSubscription,
	BillingUsage,
	CatalogPlan,
} from "@maple/domain/http"
import { estimateCycleCost } from "./cost-estimate"

// The mock builders construct only the consumed subset of each domain schema;
// `as` casts keep them terse (all fields are optional in the schemas anyway).
type Customer = BillingCustomer
type Subscription = BillingSubscription
type Plan = CatalogPlan

function buildSubscription(partial: Partial<Subscription> = {}): Subscription {
	return {
		planId: "startup",
		status: "active",
		addOn: false,
		...partial,
	} as Subscription
}

function buildCustomer(
	subscriptions: Subscription[],
	balances: Record<string, Partial<BillingBalance>> = {},
): Customer {
	return { id: "cus_1", subscriptions, balances } as Customer
}

// Mirrors apps/api/autumn.config.ts: $39/mo base, 100 GB included per signal at
// $0.30/GB overage, 5000 sessions at $0.003/session.
const startupPlan = {
	id: "startup",
	name: "Startup",
	addOn: false,
	price: { amount: 39, interval: "month" },
	items: [
		{ featureId: "logs", included: 100, price: { amount: 0.3, billingUnits: 1 } },
		{ featureId: "traces", included: 100, price: { amount: 0.3, billingUnits: 1 } },
		{ featureId: "metrics", included: 100, price: { amount: 0.3, billingUnits: 1 } },
		{ featureId: "browser_sessions", included: 5000, price: { amount: 0.003, billingUnits: 1 } },
	],
} as unknown as Plan

const usage = (total: Record<string, number>): BillingUsage["total"] =>
	Object.fromEntries(Object.entries(total).map(([k, sum]) => [k, { sum }])) as BillingUsage["total"]

describe("estimateCycleCost", () => {
	it("returns null with no active subscription", () => {
		expect(
			estimateCycleCost({ customer: buildCustomer([]), plans: [startupPlan], usage: {} }),
		).toBeNull()
		expect(estimateCycleCost({ customer: undefined, plans: [startupPlan], usage: {} })).toBeNull()
		expect(
			estimateCycleCost({
				customer: buildCustomer([buildSubscription({ status: "expired" })]),
				plans: [startupPlan],
				usage: {},
			}),
		).toBeNull()
	})

	it("under all limits: base plan price only", () => {
		const estimate = estimateCycleCost({
			customer: buildCustomer([buildSubscription()], { logs: { granted: 100 } }),
			plans: [startupPlan],
			usage: usage({ logs: 40, traces: 10 }),
		})
		expect(estimate).not.toBeNull()
		expect(estimate!.lines).toHaveLength(1)
		expect(estimate!.lines[0]).toMatchObject({ key: "base:startup", amount: 39 })
		expect(estimate!.total).toBe(39)
		expect(estimate!.partial).toBe(false)
	})

	it("bills overage beyond the granted amount at the catalog rate", () => {
		const estimate = estimateCycleCost({
			customer: buildCustomer([buildSubscription()], {
				logs: { granted: 100 },
				browser_sessions: { granted: 5000 },
			}),
			plans: [startupPlan],
			usage: usage({ logs: 112.4, browser_sessions: 7000 }),
		})
		const logs = estimate!.lines.find((l) => l.key === "overage:logs")
		const sessions = estimate!.lines.find((l) => l.key === "overage:browser_sessions")
		// 12.4 GB over → ceil(12.4) = 13 units × $0.30
		expect(logs!.amount).toBeCloseTo(3.9)
		// 2000 sessions over × $0.003
		expect(sessions!.amount).toBeCloseTo(6)
		expect(estimate!.total).toBeCloseTo(39 + 3.9 + 6)
		expect(estimate!.partial).toBe(false)
	})

	it("rounds overage up per billingUnits block", () => {
		const plan = {
			...startupPlan,
			items: [{ featureId: "logs", included: 100, price: { amount: 1.5, billingUnits: 10 } }],
		} as unknown as Plan
		const estimate = estimateCycleCost({
			customer: buildCustomer([buildSubscription()], { logs: { granted: 100 } }),
			plans: [plan],
			usage: usage({ logs: 111 }),
		})
		// 11 GB over → ceil(11/10) = 2 blocks × $1.50
		expect(estimate!.lines.find((l) => l.key === "overage:logs")!.amount).toBe(3)
	})

	it("falls back to the catalog's included amount when the balance grant is absent", () => {
		const estimate = estimateCycleCost({
			customer: buildCustomer([buildSubscription()]),
			plans: [startupPlan],
			usage: usage({ logs: 150 }),
		})
		// included falls back to the catalog's 100 GB → 50 over × $0.30
		expect(estimate!.lines.find((l) => l.key === "overage:logs")!.amount).toBeCloseTo(15)
	})

	it("an unlimited balance contributes no overage", () => {
		const estimate = estimateCycleCost({
			customer: buildCustomer([buildSubscription()], { logs: { unlimited: true } }),
			plans: [startupPlan],
			usage: usage({ logs: 900 }),
		})
		expect(estimate!.lines.find((l) => l.key === "overage:logs")).toBeUndefined()
	})

	it("legacy plan absent from the catalog: partial lower-bound estimate", () => {
		const estimate = estimateCycleCost({
			customer: buildCustomer([buildSubscription({ planId: "old-pro" })], {
				logs: { granted: 10 },
			}),
			plans: [startupPlan],
			usage: usage({ logs: 50 }),
		})
		// Active sub exists but its plan isn't in the catalog: no base price, and
		// the logs overage has no rate — flagged partial, never guessed.
		expect(estimate).not.toBeNull()
		expect(estimate!.lines).toHaveLength(0)
		expect(estimate!.total).toBe(0)
		expect(estimate!.partial).toBe(true)
	})

	it("includes an active add-on's base price", () => {
		const addOn = {
			id: "bringyourowncloud",
			name: "Bring your own cloud",
			addOn: true,
			price: { amount: 99, interval: "month" },
			items: [],
		} as unknown as Plan
		const estimate = estimateCycleCost({
			customer: buildCustomer([
				buildSubscription(),
				buildSubscription({ planId: "bringyourowncloud", addOn: true }),
			]),
			plans: [startupPlan, addOn],
			usage: {},
		})
		expect(estimate!.total).toBe(39 + 99)
	})
})

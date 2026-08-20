import { describe, expect, it } from "vitest"
import type { BillingBalance, BillingCustomer, BillingSubscription, CatalogPlan } from "@maple/domain/http"
import {
	getFeatureQuotas,
	getLapsedPlan,
	getLegacyPlanInfo,
	getPastDueSubscription,
	getQuotaStatus,
	hasBringYourOwnCloudAddOn,
	hasLapsedPlan,
	hasSelectedPlan,
	isLegacyPlan,
	isUsableCustomer,
	isUsageBasedPlan,
} from "./plan-gating"

// The mock builders construct only the consumed subset of each domain schema;
// `as` casts keep them terse (all fields are optional in the schemas anyway).
type Customer = BillingCustomer
type Subscription = BillingSubscription
type Balance = BillingBalance
type Plan = CatalogPlan

function buildBalance(_featureId: string, partial: Partial<Balance> = {}): Balance {
	return {
		granted: 50,
		remaining: 50,
		usage: 0,
		unlimited: false,
		overageAllowed: false,
		...partial,
	} as Balance
}

function buildCustomer(
	subscriptions: Subscription[],
	overrides: { flags?: Customer["flags"]; balances?: Customer["balances"] } = {},
): Customer {
	return {
		id: "cus_1",
		subscriptions,
		balances: overrides.balances ?? {},
		flags: overrides.flags ?? {},
	} as Customer
}

function buildSubscription(partial: Partial<Subscription> = {}): Subscription {
	return {
		planId: "starter",
		plan: { name: "Starter", archived: false },
		autoEnable: false,
		addOn: false,
		status: "active",
		pastDue: false,
		trialEndsAt: null,
		currentPeriodStart: null,
		currentPeriodEnd: null,
		quantity: 1,
		...partial,
	} as Subscription
}

function buildPlan(partial: Partial<Plan> = {}): Plan {
	return {
		id: "startup",
		name: "Startup",
		description: null,
		addOn: false,
		autoEnable: false,
		price: { amount: 39, interval: "month" },
		items: [],
		archived: false,
		...partial,
	} as Plan
}

describe("hasSelectedPlan", () => {
	it("returns false when customer is missing", () => {
		expect(hasSelectedPlan(null)).toBe(false)
		expect(hasSelectedPlan(undefined)).toBe(false)
	})

	it("returns true for active paid base plans", () => {
		const customer = buildCustomer([buildSubscription()])
		expect(hasSelectedPlan(customer)).toBe(true)
	})

	it("returns true for trialing plans (active status with trialEndsAt set)", () => {
		const trialingCustomer = buildCustomer([
			buildSubscription({ status: "active", trialEndsAt: Date.now() + 86400000 }),
		])
		expect(hasSelectedPlan(trialingCustomer)).toBe(true)
	})

	it("returns false for free, add-on, auto-enabled, or scheduled-only subscriptions", () => {
		const freeCustomer = buildCustomer([
			buildSubscription({
				planId: "free",
				plan: { name: "Free", archived: false },
			}),
		])
		const addOnCustomer = buildCustomer([buildSubscription({ addOn: true })])
		const defaultCustomer = buildCustomer([buildSubscription({ autoEnable: true })])
		const scheduledCustomer = buildCustomer([
			buildSubscription({ status: "scheduled" as Subscription["status"] }),
		])

		expect(hasSelectedPlan(freeCustomer)).toBe(false)
		expect(hasSelectedPlan(addOnCustomer)).toBe(false)
		expect(hasSelectedPlan(defaultCustomer)).toBe(false)
		expect(hasSelectedPlan(scheduledCustomer)).toBe(false)
	})
})

describe("getLapsedPlan / hasLapsedPlan", () => {
	it("returns nothing for an org that never held a plan", () => {
		expect(hasLapsedPlan(buildCustomer([]))).toBe(false)
		expect(hasLapsedPlan(buildCustomer([buildSubscription({ status: "expired", addOn: true })]))).toBe(
			false,
		)
		expect(
			hasLapsedPlan(buildCustomer([buildSubscription({ status: "expired", autoEnable: true })])),
		).toBe(false)
		expect(
			hasLapsedPlan(
				buildCustomer([
					buildSubscription({
						status: "expired",
						planId: "free",
						plan: { name: "Free", archived: false },
					}),
				]),
			),
		).toBe(false)
	})

	it("returns the plan for an org whose subscription lapsed", () => {
		const expired = buildCustomer([buildSubscription({ status: "expired" })])
		const canceled = buildCustomer([buildSubscription({ status: "canceled" })])

		expect(hasLapsedPlan(expired)).toBe(true)
		expect(hasLapsedPlan(canceled)).toBe(true)
		expect(getLapsedPlan(expired)?.planId).toBe("starter")
	})

	it("returns nothing while an active plan exists, even alongside an expired one", () => {
		const customer = buildCustomer([
			buildSubscription({ planId: "old", status: "expired" }),
			buildSubscription({ planId: "startup", status: "active" }),
		])
		expect(hasLapsedPlan(customer)).toBe(false)
	})

	it("picks the most recently ended subscription", () => {
		const customer = buildCustomer([
			buildSubscription({ planId: "old", status: "expired", currentPeriodEnd: 1_000 }),
			buildSubscription({ planId: "recent", status: "expired", currentPeriodEnd: 5_000 }),
		])
		expect(getLapsedPlan(customer)?.planId).toBe("recent")
	})

	it("returns nothing when there is no customer at all", () => {
		expect(hasLapsedPlan(null)).toBe(false)
		expect(hasLapsedPlan(undefined)).toBe(false)
		expect(getLapsedPlan(null)).toBeNull()
	})
})

describe("hasBringYourOwnCloudAddOn", () => {
	it("returns false when customer is missing", () => {
		expect(hasBringYourOwnCloudAddOn(null)).toBe(false)
		expect(hasBringYourOwnCloudAddOn(undefined)).toBe(false)
	})

	it("returns true when bringyourowncloud flag is present", () => {
		const customer = buildCustomer([], {
			flags: {
				bringyourowncloud: {
					id: "flag_1",
					planId: null,
					expiresAt: null,
					featureId: "bringyourowncloud",
				},
			},
		})

		expect(hasBringYourOwnCloudAddOn(customer)).toBe(true)
	})

	it("returns false when bringyourowncloud flag is missing", () => {
		const customer = buildCustomer([])

		expect(hasBringYourOwnCloudAddOn(customer)).toBe(false)
	})
})

describe("malformed / error-shaped customer payloads", () => {
	// Autumn's `useCustomer` surfaces an upstream response-validation failure as a
	// `200` whose body is `{ code: "autumn_api_error" }` — it has no
	// `subscriptions`/`flags`. The gating helpers must treat it as "no usable
	// customer" rather than throwing `Cannot read properties of undefined
	// (reading 'find')`, which previously took down every route.
	// SAFETY: this test intentionally passes Autumn's malformed error body through the customer-shaped boundary.
	const errorPayload = {
		message: "Response validation failed",
		code: "autumn_api_error",
		statusCode: 200,
	} as unknown as Customer

	it("isUsableCustomer distinguishes real customers from error payloads", () => {
		expect(isUsableCustomer(null)).toBe(false)
		expect(isUsableCustomer(undefined)).toBe(false)
		expect(isUsableCustomer(errorPayload)).toBe(false)
		expect(isUsableCustomer(buildCustomer([]))).toBe(true)
	})

	it("gating helpers never throw on an error payload and fail closed", () => {
		expect(() => hasSelectedPlan(errorPayload)).not.toThrow()
		expect(hasSelectedPlan(errorPayload)).toBe(false)
		// An Autumn error must never read as "this org used to have a plan" — that
		// would wave a brand-new org past the onboarding gate.
		expect(() => hasLapsedPlan(errorPayload)).not.toThrow()
		expect(hasLapsedPlan(errorPayload)).toBe(false)
		expect(hasBringYourOwnCloudAddOn(errorPayload)).toBe(false)
		expect(isUsageBasedPlan(errorPayload)).toBe(false)
		expect(getQuotaStatus(errorPayload)).toBe("ok")
		expect(getFeatureQuotas(errorPayload)).toEqual([])
	})
})

describe("isUsageBasedPlan", () => {
	it("returns false when customer or balances are missing", () => {
		expect(isUsageBasedPlan(null)).toBe(false)
		expect(isUsageBasedPlan(buildCustomer([]))).toBe(false)
	})

	it("returns false for a base plan (no overage allowed)", () => {
		const customer = buildCustomer([buildSubscription()], {
			balances: { logs: buildBalance("logs"), traces: buildBalance("traces") },
		})
		expect(isUsageBasedPlan(customer)).toBe(false)
	})

	it("returns true when any metered feature allows overage", () => {
		const customer = buildCustomer([buildSubscription()], {
			balances: {
				logs: buildBalance("logs", { overageAllowed: true }),
				traces: buildBalance("traces"),
			},
		})
		expect(isUsageBasedPlan(customer)).toBe(true)
	})
})

describe("getQuotaStatus / getFeatureQuotas", () => {
	it("returns ok when under 80% of grant", () => {
		const customer = buildCustomer([buildSubscription()], {
			balances: { logs: buildBalance("logs", { granted: 50, usage: 30 }) },
		})
		expect(getQuotaStatus(customer)).toBe("ok")
	})

	it("returns approaching between 80% and 100%", () => {
		const customer = buildCustomer([buildSubscription()], {
			balances: { logs: buildBalance("logs", { granted: 50, usage: 45 }) },
		})
		expect(getQuotaStatus(customer)).toBe("approaching")
	})

	it("returns over at or above 100%", () => {
		const customer = buildCustomer([buildSubscription()], {
			balances: { logs: buildBalance("logs", { granted: 50, usage: 55 }) },
		})
		expect(getQuotaStatus(customer)).toBe("over")
	})

	it("takes the worst standing across features", () => {
		const customer = buildCustomer([buildSubscription()], {
			balances: {
				logs: buildBalance("logs", { granted: 50, usage: 10 }),
				traces: buildBalance("traces", { granted: 50, usage: 60 }),
			},
		})
		expect(getQuotaStatus(customer)).toBe("over")
	})

	it("never flags usage-based features (overage allowed)", () => {
		const customer = buildCustomer([buildSubscription()], {
			balances: { logs: buildBalance("logs", { granted: 50, usage: 200, overageAllowed: true }) },
		})
		expect(getQuotaStatus(customer)).toBe("ok")
		expect(getFeatureQuotas(customer)).toHaveLength(0)
	})

	it("never flags unlimited features", () => {
		const customer = buildCustomer([buildSubscription()], {
			balances: { logs: buildBalance("logs", { unlimited: true, usage: 999 }) },
		})
		expect(getQuotaStatus(customer)).toBe("ok")
	})

	it("ignores features with no grant", () => {
		const customer = buildCustomer([buildSubscription()], {
			balances: { logs: buildBalance("logs", { granted: 0, usage: 5 }) },
		})
		expect(getFeatureQuotas(customer)).toHaveLength(0)
		expect(getQuotaStatus(customer)).toBe("ok")
	})
})

describe("getPastDueSubscription", () => {
	it("returns null when customer is missing or error-shaped", () => {
		expect(getPastDueSubscription(null)).toBeNull()
		expect(getPastDueSubscription(buildCustomer([]))).toBeNull()
	})

	it("returns the past-due subscription", () => {
		const sub = buildSubscription({ planId: "past_due_plan", pastDue: true })
		expect(getPastDueSubscription(buildCustomer([sub]))?.planId).toBe("past_due_plan")
	})

	it("returns null when no subscription is past due", () => {
		expect(getPastDueSubscription(buildCustomer([buildSubscription()]))).toBeNull()
	})

	it("ignores add-on subscriptions", () => {
		const addOn = buildSubscription({ addOn: true, pastDue: true })
		expect(getPastDueSubscription(buildCustomer([addOn]))).toBeNull()
	})
})

describe("isLegacyPlan / getLegacyPlanInfo", () => {
	// Current catalog from listPlans: only "startup" is offered.
	const catalog = [buildPlan({ id: "startup", name: "Startup" })]

	it("flags the legacy free tier regardless of catalog", () => {
		expect(isLegacyPlan(buildSubscription({ planId: "free" }), catalog)).toBe(true)
		expect(
			isLegacyPlan(buildSubscription({ planId: "old", plan: buildPlan({ name: "Free" }) }), catalog),
		).toBe(true)
	})

	it("flags a plan that is no longer in the catalog", () => {
		expect(isLegacyPlan(buildSubscription({ planId: "starter" }), catalog)).toBe(true)
	})

	it("flags a catalog plan marked archived", () => {
		const archivedCatalog = [buildPlan({ id: "startup", archived: true })]
		expect(isLegacyPlan(buildSubscription({ planId: "startup" }), archivedCatalog)).toBe(true)
	})

	it("does not flag a current, offered plan", () => {
		expect(isLegacyPlan(buildSubscription({ planId: "startup" }), catalog)).toBe(false)
	})

	it("does not flag while the catalog is still unknown (loading)", () => {
		expect(isLegacyPlan(buildSubscription({ planId: "starter" }), null)).toBe(false)
		expect(isLegacyPlan(buildSubscription({ planId: "starter" }), [])).toBe(false)
	})

	it("getLegacyPlanInfo reflects the active plan against the catalog", () => {
		const legacy = buildCustomer([
			buildSubscription({ planId: "starter", plan: buildPlan({ id: "starter", name: "Starter" }) }),
		])
		expect(getLegacyPlanInfo(legacy, catalog)).toEqual({ isLegacy: true, planName: "Starter" })

		const current = buildCustomer([
			buildSubscription({ planId: "startup", plan: buildPlan({ id: "startup", name: "Startup" }) }),
		])
		expect(getLegacyPlanInfo(current, catalog)).toEqual({ isLegacy: false, planName: "Startup" })

		expect(getLegacyPlanInfo(buildCustomer([]), catalog)).toEqual({ isLegacy: false, planName: null })
	})

	it("falls back to planId for the name when the subscription has no plan object", () => {
		// getOrCreateCustomer does not expand subscription.plan in practice.
		const customer = buildCustomer([buildSubscription({ planId: "starter", plan: undefined })])
		expect(getLegacyPlanInfo(customer, catalog)).toEqual({ isLegacy: true, planName: "starter" })
	})
})

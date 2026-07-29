import {
	cycleSpend,
	isActivePlanSubscription,
	isPricedPlan,
	resolveSubscriptionPlan,
	type FeatureUsagePricing,
} from "@maple/domain/billing"
import type { BillingCustomer, BillingUsage, CatalogPlan, SpendLimits } from "@maple/domain/http"

/**
 * Pure spend-limit evaluation: given an org's Autumn snapshot and its configured
 * guardrails, decide whether the cycle has breached the ceiling and which alert
 * thresholds were crossed for the first time.
 *
 * Pure on purpose — the cron owns the I/O (Autumn reads, Postgres writes) and
 * this owns the decision, so the "when do we pause a customer's ingestion?"
 * rule is testable without a network or a database.
 */

/** Features Maple meters. Order fixes the "top driver" tie-break. */
export const METERED_FEATURES = ["logs", "traces", "metrics", "browser_sessions"] as const

export interface SpendEvaluation {
	readonly spendCents: number
	readonly baseCents: number
	readonly overageCents: number
	readonly overageByFeature: Record<string, number>
	/** True when a ceiling exists and spend has reached it. */
	readonly breached: boolean
	/** Percent of the ceiling used, or null when there is no ceiling. */
	readonly percentUsed: number | null
	/** Configured thresholds at or below current spend. */
	readonly crossedThresholds: ReadonlyArray<number>
	/** Crossed thresholds not yet notified in this cycle — what to send. */
	readonly newlyCrossedThresholds: ReadonlyArray<number>
	/** True when a per-feature cap has been exceeded, independent of the ceiling. */
	readonly exceededCaps: ReadonlyArray<string>
	/** The estimate is a lower bound (legacy plan, or overage with no known rate). */
	readonly partial: boolean
}

/**
 * Build the per-feature pricing inputs from the customer's balances and the
 * plan governing this cycle.
 *
 * Included amounts come from `balances` (the same source the usage meters read)
 * so the evaluator can't price against a different allotment than the page
 * shows; rates come from the resolved plan — the customer's own expanded plan
 * when they have one, else the catalog.
 */
export const featurePricingFor = ({
	customer,
	plans,
	usage,
}: {
	readonly customer: BillingCustomer
	readonly plans: ReadonlyArray<CatalogPlan>
	readonly usage: BillingUsage["total"] | undefined
}): Record<string, FeatureUsagePricing> => {
	const activeSub = customer.subscriptions.find((sub) => isActivePlanSubscription(sub))
	// The customer's own expanded plan wins over the catalog: on a custom plan the
	// catalog's rates belong to somebody else, and pausing ingestion on a number
	// computed from them would be indefensible.
	const basePlan = activeSub ? resolveSubscriptionPlan(activeSub, plans) : null

	const features: Record<string, FeatureUsagePricing> = {}
	for (const featureId of METERED_FEATURES) {
		const balance = customer.balances?.[featureId]
		const item = basePlan?.items?.find((entry) => entry.featureId === featureId)
		features[featureId] = {
			used: usage?.[featureId]?.sum ?? 0,
			included: balance?.granted ?? item?.included ?? null,
			ratePerUnit: item?.price?.amount ?? null,
			unlimited: balance?.unlimited === true,
			// A hard-capped feature bills no overage — see `billsOverage`.
			overageAllowed: balance?.overageAllowed,
		}
	}
	return features
}

/** Base subscription dollars for the cycle: the active plan plus active add-ons. */
export const baseDollarsFor = ({
	customer,
	plans,
}: {
	readonly customer: BillingCustomer
	readonly plans: ReadonlyArray<CatalogPlan>
}): number | null => {
	const activeSubs = customer.subscriptions.filter(
		(sub) => isActivePlanSubscription(sub) || (sub.addOn === true && sub.status === "active"),
	)
	if (activeSubs.length === 0) return null

	let total = 0
	for (const sub of activeSubs) {
		const plan = resolveSubscriptionPlan(sub, plans)
		// A plan we can price from neither source has no knowable price: return
		// null so the whole estimate is marked partial rather than silently missing
		// a base fee and reading as under-limit.
		if (!isPricedPlan(plan)) return null
		const amount = plan?.price?.amount
		if (amount == null) {
			if (!sub.autoEnable) return null
			continue
		}
		const quantity = sub.quantity != null && sub.quantity > 1 ? sub.quantity : 1
		total += amount * quantity
	}
	return total
}

export const evaluateSpendLimits = ({
	limits,
	customer,
	plans,
	usage,
	cycleStartMs,
	previousCycleStartMs,
	previouslyNotified,
}: {
	readonly limits: SpendLimits
	readonly customer: BillingCustomer
	readonly plans: ReadonlyArray<CatalogPlan>
	readonly usage: BillingUsage["total"] | undefined
	readonly cycleStartMs: number
	readonly previousCycleStartMs: number | null
	readonly previouslyNotified: ReadonlyArray<number>
}): SpendEvaluation => {
	const features = featurePricingFor({ customer, plans, usage })
	const spend = cycleSpend({ baseDollars: baseDollarsFor({ customer, plans }), features })

	const ceiling = limits.monthlyLimitCents
	const percentUsed = ceiling === null || ceiling <= 0 ? null : (spend.totalCents / ceiling) * 100
	const breached = ceiling !== null && spend.totalCents >= ceiling

	const crossedThresholds =
		percentUsed === null
			? []
			: limits.alertThresholdPercents.filter((percent) => percentUsed >= percent)

	// A cycle rollover resets notification state: crossing 80% in August must
	// alert again even though July already did.
	const sameCycle = previousCycleStartMs === cycleStartMs
	const alreadyNotified = sameCycle ? previouslyNotified : []
	const newlyCrossedThresholds = crossedThresholds.filter(
		(percent) => !alreadyNotified.includes(percent),
	)

	const exceededCaps = Object.entries(limits.featureCaps)
		.filter(([featureId, cap]) => cap != null && (features[featureId]?.used ?? 0) > cap)
		.map(([featureId]) => featureId)

	return {
		spendCents: spend.totalCents,
		baseCents: spend.baseCents,
		overageCents: spend.overageCents,
		overageByFeature: spend.overageByFeature,
		breached,
		percentUsed,
		crossedThresholds,
		newlyCrossedThresholds,
		exceededCaps,
		partial: spend.partial,
	}
}

import { isActivePlanSubscription } from "@maple/domain/billing"
import type { BillingBalance, BillingCustomer, BillingSubscription, CatalogPlan } from "@maple/domain/http"

type Customer = BillingCustomer

type Subscription = BillingSubscription

type Balance = BillingBalance

// A plan from the live `listPlans` catalog — the source of truth for which plans
// are currently offered and for per-feature overage rates. `getOrCreateCustomer`
// does NOT expand `subscription.plan`, so neither legacy detection nor overage
// rates can rely on it; both read the catalog instead.
export type { CatalogPlan }

// Metered ingestion features whose usage we surface alerts for. Mirrors the
// Autumn feature ids defined in apps/api/autumn.config.ts.
const METERED_INGEST_FEATURES = ["logs", "traces", "metrics"] as const

// Surface a warning once usage crosses 80% of the included grant; "over" once it
// reaches 100%. Mirrors the meter thresholds in feature-usage-cards.tsx.
const APPROACHING_RATIO = 0.8

export type QuotaLevel = "ok" | "approaching" | "over"

export interface FeatureQuota {
	featureId: string
	usage: number
	granted: number
	ratio: number
	level: QuotaLevel
}

function isLegacyFreePlan(sub: Subscription): boolean {
	if (sub.planId.toLowerCase() === "free") return true
	return sub.plan?.name?.toLowerCase() === "free"
}

// A subscription is "legacy" when its plan is no longer offered to new customers:
// it's the old free tier, or its planId isn't in the current `listPlans` catalog,
// or it maps to a catalog plan flagged archived. We only fall back to the
// catalog-membership check once the catalog has loaded — an empty/missing catalog
// means "unknown", not "legacy", so the badge never flickers on during load.
export function isLegacyPlan(
	sub: Subscription,
	plans: ReadonlyArray<CatalogPlan> | null | undefined,
): boolean {
	if (isLegacyFreePlan(sub)) return true
	if (sub.plan?.archived === true) return true
	if (!plans || plans.length === 0) return false
	const catalogPlan = plans.find((plan) => plan.id === sub.planId)
	if (!catalogPlan) return true
	return catalogPlan.archived === true
}

// Autumn's `useCustomer` surfaces upstream API failures (e.g. a `200` whose
// body is an `autumn_api_error` from a failed response validation) as `data`
// rather than `error`. Those payloads have no `subscriptions`/`balances`, so a
// blind `customer.subscriptions.find(...)` would throw and take down every
// route. Treat anything without a `subscriptions` array as "no usable customer"
// and let callers fail open instead of crashing.
export function isUsableCustomer(customer: Customer | null | undefined): customer is Customer {
	return !!customer && Array.isArray(customer.subscriptions)
}

export function getActivePlan(customer: Customer | null | undefined): Subscription | null {
	if (!isUsableCustomer(customer)) return null
	return customer.subscriptions.find((sub) => isActivePlanSubscription(sub)) ?? null
}

export function hasSelectedPlan(customer: Customer | null | undefined): boolean {
	return getActivePlan(customer) !== null
}

export interface TrialStatus {
	isTrialing: boolean
	daysRemaining: number | null
	trialEndsAt: Date | null
	planName: string | null
	planId: string | null
	planStatus: string | null
}

// Trial standing for the org's active plan, derived purely from the customer.
// `isTrialing` when the active sub carries a future `trialEndsAt`. Drives the
// billing subscription strip and the pricing cards' trial badges.
export function getTrialStatus(customer: Customer | null | undefined): TrialStatus {
	const sub = getActivePlan(customer)
	if (!sub) {
		return {
			isTrialing: false,
			daysRemaining: null,
			trialEndsAt: null,
			planName: null,
			planId: null,
			planStatus: null,
		}
	}

	const isTrialing = sub.trialEndsAt != null && sub.trialEndsAt > Date.now()
	let daysRemaining: number | null = null
	let trialEndsAt: Date | null = null

	if (isTrialing && sub.trialEndsAt) {
		trialEndsAt = new Date(sub.trialEndsAt)
		const msRemaining = trialEndsAt.getTime() - Date.now()
		daysRemaining = msRemaining > 0 ? Math.ceil(msRemaining / (1000 * 60 * 60 * 24)) : 0
	}

	return {
		isTrialing,
		daysRemaining,
		trialEndsAt,
		planName: sub.plan?.name ?? sub.planId,
		planId: sub.planId,
		planStatus: sub.status,
	}
}

export function hasBringYourOwnCloudAddOn(customer: Customer | null | undefined): boolean {
	if (!customer) return false

	return !!customer.flags?.bringyourowncloud
}

// A balance is "hard-capped" when it has a finite grant and bills no overage —
// i.e. a base-plan feature with a fixed included amount. Unlimited or
// overage-allowed (usage-based) features are never hard-capped.
function isHardCapped(balance: Balance | undefined): balance is Balance {
	if (!balance) return false
	if (balance.unlimited || balance.overageAllowed) return false
	return (balance.granted ?? 0) > 0
}

// True when any metered ingest feature bills usage-based overage. Such orgs have
// no fixed cap, so they should never see a usage-limit alert.
export function isUsageBasedPlan(customer: Customer | null | undefined): boolean {
	const balances = customer?.balances
	if (!balances) return false
	return METERED_INGEST_FEATURES.some((featureId) => balances[featureId]?.overageAllowed === true)
}

// Per-feature quota standing for the hard-capped (base-plan) ingest features.
// Features that are unlimited, usage-based, or un-granted are omitted.
export function getFeatureQuotas(customer: Customer | null | undefined): FeatureQuota[] {
	const balances = customer?.balances
	if (!balances) return []

	const quotas: FeatureQuota[] = []
	for (const featureId of METERED_INGEST_FEATURES) {
		const balance = balances[featureId]
		if (!isHardCapped(balance)) continue

		const granted = balance.granted ?? 0
		const usage = balance.usage ?? 0
		const ratio = granted > 0 ? usage / granted : 0
		const level: QuotaLevel = ratio >= 1 ? "over" : ratio >= APPROACHING_RATIO ? "approaching" : "ok"
		quotas.push({ featureId, usage, granted, ratio, level })
	}
	return quotas
}

// Worst-case quota standing across a base-plan org's hard-capped ingest
// features. "over" means at/over the included limit; "approaching" means within
// 80–100%. Purely informational (drives the in-app usage alert) — nothing is
// blocked. Usage-based and unlimited orgs always resolve to "ok".
export function getQuotaStatus(customer: Customer | null | undefined): QuotaLevel {
	const quotas = getFeatureQuotas(customer)
	if (quotas.some((quota) => quota.level === "over")) return "over"
	if (quotas.some((quota) => quota.level === "approaching")) return "approaching"
	return "ok"
}

// The first non-add-on subscription with overdue payments, or null. Not gated on
// `status === "active"` — a past-due sub may carry any status, and we always want
// to surface it.
export function getPastDueSubscription(customer: Customer | null | undefined): Subscription | null {
	if (!isUsableCustomer(customer)) return null
	return customer.subscriptions.find((sub) => !sub.addOn && sub.pastDue === true) ?? null
}

// Whether the org's active plan is a legacy/grandfathered one, plus its display
// name (for the billing badge). Mirrors the plan shown in the subscription strip.
export function getLegacyPlanInfo(
	customer: Customer | null | undefined,
	plans: ReadonlyArray<CatalogPlan> | null | undefined,
): {
	isLegacy: boolean
	planName: string | null
} {
	const sub = getActivePlan(customer)
	if (!sub) return { isLegacy: false, planName: null }
	return { isLegacy: isLegacyPlan(sub, plans), planName: sub.plan?.name ?? sub.planId }
}

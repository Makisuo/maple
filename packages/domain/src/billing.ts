/**
 * Shared billing gate — the single source of truth for "is this an actively
 * selected paid plan?", used by both the web redirect gate
 * (apps/web/src/lib/billing/plan-gating.ts) and the API customer-cache TTL
 * (apps/api/src/routes/autumn.http.ts) so the two can't drift. Structurally
 * typed so `autumn-js` stays out of `@maple/domain`; Autumn's `Subscription`
 * shape satisfies it.
 */
export interface PlanGatingSubscription {
	readonly status?: string | null
	readonly addOn?: boolean | null
	readonly autoEnable?: boolean | null
	readonly planId?: string | null
	readonly plan?: { readonly name?: string | null } | null
}

/** Active, and not an add-on / auto-enabled / legacy-free tier. Trials count — Autumn reports them as `active`. */
export function isActivePlanSubscription(sub: PlanGatingSubscription | null | undefined): boolean {
	if (!sub) return false
	if (sub.addOn || sub.autoEnable) return false
	if (sub.planId?.toLowerCase() === "free" || sub.plan?.name?.toLowerCase() === "free") return false
	return sub.status === "active"
}

// Cycle pricing
//
// One definition of "what does this cycle cost so far", in cents, used by the
// billing page's spend chart and invoice estimates.
//
// Cents throughout. Rates are per-unit dollars in the Autumn catalog (e.g.
// $0.30/GB, $0.002/session), so the multiply happens in cents and rounds once,
// at the end — not per feature.

export interface FeatureUsagePricing {
	/** Usage this cycle, in the feature's billed unit (GB, or a raw count). */
	readonly used: number
	/** Included allotment in the same unit. `null` when unknown — priced as 0 overage. */
	readonly included: number | null
	/** Overage price per unit, in dollars. `null` when unknown — the estimate is partial. */
	readonly ratePerUnit: number | null
	/** True when the feature is unlimited on this plan: never any overage. */
	readonly unlimited?: boolean
	/**
	 * `false` when the plan hard-caps this feature: usage past the allotment is
	 * rejected, never billed. Distinct from "we don't know the rate" — a hard cap
	 * costs a knowable $0, so it must NOT make the estimate partial. Autumn reports
	 * it per feature on the customer's balances.
	 */
	readonly overageAllowed?: boolean
}

export interface CycleSpend {
	readonly totalCents: number
	readonly baseCents: number
	readonly overageCents: number
	/** Overage cents per featureId, for the "top cost driver" and the per-feature cards. */
	readonly overageByFeature: Record<string, number>
	/**
	 * True when some component couldn't be priced (a legacy plan absent from the
	 * catalog, or overage with no known rate). The total is then a lower bound.
	 */
	readonly partial: boolean
}

const toCents = (dollars: number) => dollars * 100

/** Units of `feature` beyond its included allotment. Never negative. */
export function overageUnits(feature: FeatureUsagePricing): number {
	if (feature.unlimited) return 0
	if (feature.included == null) return 0
	return Math.max(0, feature.used - feature.included)
}

/** Can this feature bill past its allotment at all? */
export const billsOverage = (feature: FeatureUsagePricing): boolean =>
	feature.unlimited !== true && feature.overageAllowed !== false

/**
 * Estimated spend for the cycle so far: base subscription price plus per-feature
 * overage. No extrapolation — projection is the caller's job, because only the
 * caller knows how far into the cycle it is.
 */
export function cycleSpend({
	baseDollars,
	features,
}: {
	/** Base subscription price(s) for the cycle, in dollars. `null` = unknown (partial). */
	readonly baseDollars: number | null
	readonly features: Readonly<Record<string, FeatureUsagePricing>>
}): CycleSpend {
	let partial = baseDollars == null
	const baseCents = Math.round(toCents(baseDollars ?? 0))

	const overageByFeature: Record<string, number> = {}
	let overageCentsExact = 0

	for (const [featureId, feature] of Object.entries(features)) {
		const units = overageUnits(feature)
		if (units <= 0) {
			overageByFeature[featureId] = 0
			continue
		}
		if (!billsOverage(feature)) {
			// Hard-capped: the excess was rejected at the gateway, not billed. A
			// knowable zero, so the estimate stays exact.
			overageByFeature[featureId] = 0
			continue
		}
		if (feature.ratePerUnit == null) {
			// Overage exists but we have no rate for it — flag the estimate rather
			// than pricing it at zero and under-reporting the bill.
			partial = true
			overageByFeature[featureId] = 0
			continue
		}
		const cents = units * toCents(feature.ratePerUnit)
		overageByFeature[featureId] = Math.round(cents)
		overageCentsExact += cents
	}

	const overageCents = Math.round(overageCentsExact)
	return {
		totalCents: baseCents + overageCents,
		baseCents,
		overageCents,
		overageByFeature,
		partial,
	}
}

/**
 * Straight-line projection of `spentCents` to the end of the cycle, holding the
 * base fee flat: only overage accrues with time. Returns `spentCents` when the
 * cycle has no elapsed portion to extrapolate from.
 */
export function projectCycleSpend({
	baseCents,
	overageCents,
	elapsedMs,
	totalMs,
}: {
	readonly baseCents: number
	readonly overageCents: number
	readonly elapsedMs: number
	readonly totalMs: number
}): number {
	if (elapsedMs <= 0 || totalMs <= 0 || elapsedMs >= totalMs) return baseCents + overageCents
	return baseCents + Math.round(overageCents * (totalMs / elapsedMs))
}

// Whose prices apply
//
// Two sources describe a plan: the customer's OWN subscription plan (expanded
// via `subscriptions.plan`) and the public catalog (`listPlans`). They agree for
// a self-serve customer and diverge for every custom-priced or grandfathered
// one — where the catalog describes what is *for sale*, not what this customer
// pays. Pricing from the catalog in that case bills them at somebody else's
// rates, so the customer's own plan always wins and the catalog is the fallback
// for the (common) case where nothing was expanded.

/** Structural view of a plan's per-feature line, from either source. */
export interface PlanItemLike {
	readonly featureId?: string | null
	readonly included?: number | null
	readonly unlimited?: boolean | null
	readonly price?: {
		readonly amount?: number | null
		/** Units the rate is quoted per (e.g. 1 GB, 1,000 sessions). */
		readonly billingUnits?: number | null
	} | null
}

/** Structural view of a plan, from either source. */
export interface PlanLike {
	readonly id?: string | null
	readonly name?: string | null
	readonly price?: { readonly amount?: number | null; readonly interval?: string | null } | null
	readonly items?: ReadonlyArray<PlanItemLike> | null
}

export interface SubscriptionLike extends PlanGatingSubscription {
	readonly plan?: PlanLike | null
	readonly quantity?: number | null
}

/**
 * The plan that governs a subscription: its own expanded plan when present (and
 * priced), else the catalog entry with the same id.
 *
 * "And priced" matters: an unexpanded `plan` carries only `{ name }`, which would
 * otherwise shadow the catalog entry that does have prices.
 */
export const resolveSubscriptionPlan = <P extends PlanLike>(
	subscription: SubscriptionLike,
	catalog: ReadonlyArray<P>,
): PlanLike | null => {
	const own = subscription.plan
	if (own && (own.price != null || (own.items != null && own.items.length > 0))) return own
	const planId = subscription.planId
	return (planId ? catalog.find((plan) => plan.id === planId) : undefined) ?? own ?? null
}

/** Is this plan's pricing knowable — i.e. can we quote a bill from it at all? */
export const isPricedPlan = (plan: PlanLike | null): boolean =>
	plan !== null && (plan.price?.amount != null || (plan.items?.length ?? 0) > 0)

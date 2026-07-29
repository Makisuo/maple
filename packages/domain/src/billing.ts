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

// ---------------------------------------------------------------------------
// Cycle pricing
//
// One definition of "what does this cycle cost so far", in cents, shared by the
// billing page's spend chart and the API's spend-limit evaluator. The two must
// agree exactly: a chart that says $199 while the evaluator pauses ingestion at
// its $200 limit is worse than either being wrong alone.
//
// Cents throughout. Rates are per-unit dollars in the Autumn catalog (e.g.
// $0.30/GB, $0.002/session), so the multiply happens in cents and rounds once,
// at the end — not per feature.
// ---------------------------------------------------------------------------

export interface FeatureUsagePricing {
	/** Usage this cycle, in the feature's billed unit (GB, or a raw count). */
	readonly used: number
	/** Included allotment in the same unit. `null` when unknown — priced as 0 overage. */
	readonly included: number | null
	/** Overage price per unit, in dollars. `null` when unknown — the estimate is partial. */
	readonly ratePerUnit: number | null
	/** True when the feature is unlimited on this plan: never any overage. */
	readonly unlimited?: boolean
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

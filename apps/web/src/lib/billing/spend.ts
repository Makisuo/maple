import type { BillingCustomer, BillingUsage, CatalogPlan, DailySpendResponse } from "@maple/domain/http"
import {
	cycleSpend,
	isActivePlanSubscription,
	isPricedPlan,
	projectCycleSpend,
	resolveSubscriptionPlan,
	type FeatureUsagePricing,
	type PlanLike,
} from "@maple/domain/billing"

/**
 * The billing page's spend model: one place that turns the Autumn snapshot plus
 * the warehouse's daily volume into every number the page renders — the KPI row,
 * the per-feature cards, and the cumulative chart.
 *
 * The dollars come from `@maple/domain/billing`, the shared pricing module.
 * Anything derived here is presentation: which day is
 * "today", how to stack the bands, what the projection line ends at.
 */

/** Features Maple meters, in the order they stack in the chart and read across the cards. */
export const SPEND_FEATURES = ["logs", "traces", "metrics", "browser_sessions"] as const
export type SpendFeatureId = (typeof SPEND_FEATURES)[number]

export const FEATURE_LABELS: Record<SpendFeatureId, string> = {
	logs: "Logs",
	traces: "Traces",
	metrics: "Metrics",
	browser_sessions: "Browser Sessions",
} satisfies Record<SpendFeatureId, string>

/**
 * Labels for tight slots — a card header that also carries a cap chip, or a chart
 * legend. "Browser Sessions" doesn't fit next to a chip at one quarter of the
 * content width, and truncating it to "Browse…" is worse than shortening it.
 */
export const FEATURE_SHORT_LABELS: Record<SpendFeatureId, string> = {
	...FEATURE_LABELS,
	browser_sessions: "Sessions",
} satisfies Record<SpendFeatureId, string>

/**
 * Series colors, validated for contrast on the card surface and for deutan CVD
 * separation. Amber is deliberately absent: it belongs to the limit line, the
 * projection, and the brand — a data band in amber would read as one of those.
 */
export const FEATURE_COLORS: Record<SpendFeatureId, string> = {
	logs: "#3987e5",
	traces: "#199e70",
	metrics: "#9085e9",
	browser_sessions: "#d55181",
} satisfies Record<SpendFeatureId, string>

/** `browser_sessions` is metered per session; every other feature per GB. */
export const featureUnit = (featureId: string): "GB" | "sessions" =>
	featureId === "browser_sessions" ? "sessions" : "GB"

export interface FeatureSpend extends FeatureUsagePricing {
	readonly featureId: SpendFeatureId
	readonly label: string
	readonly overageUnits: number
	readonly overageCents: number
}

export interface SpendModel {
	readonly currency: string
	readonly baseCents: number
	readonly overageCents: number
	readonly spendCents: number
	readonly projectedCents: number
	readonly partial: boolean
	readonly features: ReadonlyArray<FeatureSpend>
	/** Highest-overage feature, or null when nothing is in overage yet. */
	readonly topDriver: FeatureSpend | null
	readonly cycle: { readonly startMs: number; readonly endMs: number; readonly nowMs: number }
	/** 1-based day of the cycle, and the cycle's length in days. */
	readonly dayOfCycle: number
	readonly cycleDays: number
	/** Name of the active plan, for the plan strip and the offer plate. */
	readonly planName: string | null
	/**
	 * The plan actually governing this cycle — the customer's own expanded plan
	 * when they have one, else the catalog entry. For a custom-priced customer
	 * this is NOT a catalog plan.
	 */
	readonly basePlan: PlanLike | null
	readonly addOns: ReadonlyArray<PlanLike>
	/**
	 * True when the governing plan isn't the public catalog entry it claims to be —
	 * a custom or grandfathered plan. The plans section must not advertise a
	 * catalog plan as theirs in that case.
	 */
	readonly isCustomPlan: boolean
}

const DAY_MS = 86_400_000

const cycleWindow = (customer: BillingCustomer | undefined, nowMs: number) => {
	const active = customer?.subscriptions?.find((sub) => sub.status === "active")
	if (active?.currentPeriodStart != null && active.currentPeriodEnd != null) {
		return { startMs: active.currentPeriodStart, endMs: active.currentPeriodEnd }
	}
	const now = new Date(nowMs)
	return {
		startMs: Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
		endMs: Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
	}
}

/**
 * Everything the page needs about this cycle's spend. Returns null only when the
 * customer hasn't loaded — a customer with no plan still has a model (zero base,
 * real usage), because the page must show usage before it shows a bill.
 */
export function buildSpendModel({
	customer,
	plans,
	usage,
	nowMs,
}: {
	readonly customer: BillingCustomer | undefined
	readonly plans: ReadonlyArray<CatalogPlan> | undefined
	readonly usage: BillingUsage["total"] | undefined
	readonly nowMs: number
}): SpendModel | null {
	if (!customer) return null

	const catalog = plans ?? []
	const activeSub = customer.subscriptions.find((sub) => isActivePlanSubscription(sub))
	// The customer's own plan wins over the catalog — see `resolveSubscriptionPlan`.
	// This is what makes usage-based pricing correct on a custom plan.
	const basePlan = activeSub ? resolveSubscriptionPlan(activeSub, catalog) : null
	const addOns = customer.subscriptions
		.filter((sub) => sub.addOn === true && sub.status === "active")
		.map((sub) => resolveSubscriptionPlan(sub, catalog))
		.filter((plan): plan is PlanLike => plan !== null)

	// A plan we can't price (neither expanded nor in the catalog) must read as
	// partial rather than as a $0 base.
	const baseDollars =
		activeSub === undefined
			? 0
			: !isPricedPlan(basePlan)
				? null
				: (basePlan?.price?.amount ?? 0) +
					addOns.reduce((sum, addOn) => sum + (addOn.price?.amount ?? 0), 0)

	const pricing: Record<string, FeatureUsagePricing> = {}
	for (const featureId of SPEND_FEATURES) {
		const balance = customer.balances?.[featureId]
		const item = basePlan?.items?.find((entry) => entry.featureId === featureId)
		pricing[featureId] = {
			used: usage?.[featureId]?.sum ?? 0,
			included: balance?.granted ?? item?.included ?? null,
			ratePerUnit: item?.price?.amount ?? null,
			unlimited: balance?.unlimited === true,
			// A hard-capped feature bills no overage — see `billsOverage`.
			overageAllowed: balance?.overageAllowed,
		}
	}

	const spend = cycleSpend({ baseDollars, features: pricing })

	const features: FeatureSpend[] = SPEND_FEATURES.map((featureId) => {
		const entry = pricing[featureId] as FeatureUsagePricing
		const overUnits =
			entry.unlimited || entry.included == null ? 0 : Math.max(0, entry.used - entry.included)
		return {
			...entry,
			featureId,
			label: FEATURE_LABELS[featureId],
			overageUnits: overUnits,
			overageCents: spend.overageByFeature[featureId] ?? 0,
		}
	})

	const topDriver =
		features.reduce<FeatureSpend | null>(
			(best, feature) =>
				feature.overageCents > 0 && (best === null || feature.overageCents > best.overageCents)
					? feature
					: best,
			null,
		) ?? null

	const cycle = cycleWindow(customer, nowMs)
	const cycleDays = Math.max(1, Math.round((cycle.endMs - cycle.startMs) / DAY_MS))
	const elapsedMs = Math.max(0, Math.min(nowMs, cycle.endMs) - cycle.startMs)
	const dayOfCycle = Math.min(cycleDays, Math.floor(elapsedMs / DAY_MS) + 1)

	return {
		currency: "usd",
		baseCents: spend.baseCents,
		overageCents: spend.overageCents,
		spendCents: spend.totalCents,
		projectedCents: projectCycleSpend({
			baseCents: spend.baseCents,
			overageCents: spend.overageCents,
			elapsedMs,
			totalMs: cycle.endMs - cycle.startMs,
		}),
		partial: spend.partial,
		features,
		topDriver,
		cycle: { ...cycle, nowMs },
		dayOfCycle,
		cycleDays,
		planName: basePlan?.name ?? activeSub?.plan?.name ?? null,
		basePlan,
		addOns,
		isCustomPlan:
			activeSub !== undefined && !catalog.some((plan) => plan.id === activeSub.planId && !plan.addOn),
	}
}

export interface CumulativePoint {
	readonly date: string
	/** Epoch ms at the start of this UTC day. */
	readonly dayMs: number
	/**
	 * Cumulative dollars, by band, at the end of this day. `null` on days that
	 * haven't happened: the stacked area has to STOP at today rather than run flat
	 * to the end of the cycle, which would read as "spend stops here".
	 */
	readonly base: number | null
	readonly logs: number | null
	readonly traces: number | null
	readonly metrics: number | null
	readonly browser_sessions: number | null
	/** Cumulative total so far, for the tooltip. `null` for future days. */
	readonly total: number | null
	/**
	 * The projection line: defined only at today (today's actual total) and at the
	 * final day of the cycle (the projected total), so a straight dashed segment
	 * connects where spend is to where it lands.
	 */
	readonly projected: number | null
	/** True for days that haven't happened yet. */
	readonly future: boolean
}

/**
 * Cumulative spend by feature, day by day.
 *
 * Overage only accrues after the included allotment is crossed, so this walks
 * the daily volumes forward and prices each day's *incremental* over-allotment
 * units. Charting each day's raw volume × rate instead would bill the first
 * (included) GB of the cycle and the chart would start above zero.
 *
 * The base fee is a flat band from day 1: it's owed on day 1, and drawing it as
 * an accruing slope would tell the customer their subscription is metered.
 *
 * The daily *shape* comes from the warehouse, but the cycle *total* comes from
 * the billing provider's meter — the number the invoice is built from. Those two
 * can disagree (a metering gap, a backfill, a replayed export), so each feature's
 * series is scaled to land on the metered total. Without that, the chart's last
 * point contradicts the "spend so far" KPI directly above it, and the customer
 * has no way to tell which one is their bill.
 */
export function buildCumulativeSeries({
	daily,
	model,
}: {
	readonly daily: DailySpendResponse | undefined
	readonly model: SpendModel
}): ReadonlyArray<CumulativePoint> {
	if (!daily || daily.days.length === 0) return []

	const baseDollars = model.baseCents / 100

	const volumeOf = (day: DailySpendResponse["days"][number], featureId: SpendFeatureId): number =>
		featureId === "logs"
			? day.logsGB
			: featureId === "traces"
				? day.tracesGB
				: featureId === "metrics"
					? day.metricsGB
					: day.browserSessions

	const byFeature = new Map<
		SpendFeatureId,
		{ used: number; included: number; rate: number; scale: number }
	>()
	for (const feature of model.features) {
		const warehouseTotal = daily.days.reduce((sum, day) => sum + volumeOf(day, feature.featureId), 0)
		byFeature.set(feature.featureId, {
			used: 0,
			included: feature.unlimited
				? Number.POSITIVE_INFINITY
				: (feature.included ?? Number.POSITIVE_INFINITY),
			rate: feature.ratePerUnit ?? 0,
			// Only scale when both sides have something to compare; otherwise the
			// warehouse shape stands on its own.
			scale: warehouseTotal > 0 && feature.used > 0 ? feature.used / warehouseTotal : 1,
		})
	}

	const accrued: Record<SpendFeatureId, number> = {
		logs: 0,
		traces: 0,
		metrics: 0,
		browser_sessions: 0,
	} satisfies Record<SpendFeatureId, number>

	const todayMs = Math.floor(model.cycle.nowMs / DAY_MS) * DAY_MS
	const lastDay = daily.days[daily.days.length - 1]
	const lastDayMs = lastDay ? Date.parse(`${lastDay.date}T00:00:00Z`) : todayMs
	const projectedTotal = model.projectedCents / 100

	return daily.days.map((day) => {
		const dayMs = Date.parse(`${day.date}T00:00:00Z`)
		const future = dayMs > todayMs

		if (!future) {
			for (const featureId of SPEND_FEATURES) {
				const state = byFeature.get(featureId)
				if (!state) continue
				const before = Math.max(0, state.used - state.included)
				state.used += volumeOf(day, featureId) * state.scale
				const after = Math.max(0, state.used - state.included)
				accrued[featureId] += (after - before) * state.rate
			}
		}

		const total = baseDollars + accrued.logs + accrued.traces + accrued.metrics + accrued.browser_sessions

		// Two anchors only. Recharts joins them into one straight dashed segment,
		// which is the honest shape for a linear projection — a curve through
		// interpolated points would imply we know the days in between.
		const projected =
			dayMs === todayMs ? total : dayMs === lastDayMs && lastDayMs > todayMs ? projectedTotal : null

		return {
			date: day.date,
			dayMs,
			base: future ? null : baseDollars,
			logs: future ? null : accrued.logs,
			traces: future ? null : accrued.traces,
			metrics: future ? null : accrued.metrics,
			browser_sessions: future ? null : accrued.browser_sessions,
			total: future ? null : total,
			projected,
			future,
		}
	})
}

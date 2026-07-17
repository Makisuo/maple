import type { BillingCustomer, BillingUsage, CatalogPlan } from "@maple/domain/http"

import { isActivePlanSubscription } from "@maple/domain/billing"
import { formatCurrency } from "./currency"
import { formatCount, formatUsage } from "./usage"

// Metered features surfaced on the billing page. AI token features stay hidden,
// matching HIDDEN_FEATURE_IDS in pricing-cards.tsx.
const METERED_FEATURES = ["logs", "traces", "metrics", "browser_sessions"] as const

const FEATURE_LABELS: Record<string, string> = {
	logs: "Logs",
	traces: "Traces",
	metrics: "Metrics",
	browser_sessions: "Browser Sessions",
}

export interface CostLine {
	key: string
	label: string
	/** e.g. "12.40 GB over included × $0.30 / GB" */
	detail?: string
	amount: number
}

export interface CycleCostEstimate {
	lines: CostLine[]
	total: number
	currency: string
	/**
	 * True when some component couldn't be priced (e.g. a legacy plan absent from
	 * the catalog) — the total is a lower bound, never a guess.
	 */
	partial: boolean
}

const featureUnit = (featureId: string): string => (featureId === "browser_sessions" ? "session" : "GB")

// Sub-cent rates (e.g. $0.003/session) would round to "$0.00" through the
// 2-decimal currency formatter, so render those raw.
const formatRate = (rate: number): string => (rate > 0 && rate < 0.01 ? `$${rate}` : formatCurrency(rate, "usd"))

const formatQuantity = (featureId: string, value: number): string =>
	featureId === "browser_sessions" ? `${formatCount(value)} sessions` : formatUsage(value)

/**
 * Actual-to-date cost estimate for the current billing cycle, computed purely
 * from data the billing page already fetches: base plan price(s) from the live
 * catalog + per-feature overage (usage beyond the granted included amount)
 * priced at the catalog's overage rates. No extrapolation — this is what the
 * cycle costs so far, excluding taxes and credits.
 *
 * Returns null when the customer has no active subscription (nothing to bill).
 */
export function estimateCycleCost({
	customer,
	plans,
	usage,
}: {
	customer: BillingCustomer | null | undefined
	plans: ReadonlyArray<CatalogPlan> | null | undefined
	usage: BillingUsage["total"] | null | undefined
}): CycleCostEstimate | null {
	if (!customer || !Array.isArray(customer.subscriptions)) return null

	const activeSubs = customer.subscriptions.filter(
		(sub) => isActivePlanSubscription(sub) || (sub.addOn === true && sub.status === "active"),
	)
	if (!activeSubs.some((sub) => isActivePlanSubscription(sub))) return null

	const catalog = plans ?? []
	const lines: CostLine[] = []
	let partial = false

	// Base subscription price(s): the active plan plus any active add-ons.
	let basePlan: CatalogPlan | undefined
	for (const sub of activeSubs) {
		const plan = catalog.find((p) => p.id === sub.planId)
		if (!plan) {
			// Legacy/grandfathered plan not in the current catalog: we don't know its
			// price or rates, so the estimate is a lower bound.
			partial = true
			continue
		}
		if (!plan.addOn) basePlan = plan
		const amount = plan.price?.amount
		if (amount == null) {
			// Free/auto-enable plans have no price object — a $0 base isn't partial.
			if (!plan.autoEnable) partial = true
			continue
		}
		const quantity = sub.quantity != null && sub.quantity > 1 ? sub.quantity : 1
		lines.push({
			key: `base:${plan.id}`,
			label: plan.addOn ? `${plan.name} add-on` : `${plan.name} plan`,
			detail: plan.price?.interval ? `Base price / ${plan.price.interval}` : "Base price",
			amount: amount * quantity,
		})
	}

	// Per-feature overage, priced from the active plan's catalog items. Included
	// amounts come from the customer's balances (the same source the usage meters
	// read) so the dollars here always agree with the meters above.
	const balances = customer.balances
	for (const featureId of METERED_FEATURES) {
		const balance = balances?.[featureId]
		if (balance?.unlimited) continue

		const item = basePlan?.items.find((i) => i.featureId === featureId)
		const included = balance?.granted ?? item?.included ?? null
		const used = usage?.[featureId]?.sum ?? 0
		if (included == null) continue
		const over = Math.max(0, used - included)
		if (over <= 0) continue

		const rate = item?.price?.amount
		if (rate == null) {
			// Overage exists but we have no rate for it (legacy plan or a feature
			// missing from the catalog) — flag the estimate as a lower bound.
			partial = true
			continue
		}
		const billingUnits = item?.price?.billingUnits ?? 1
		const units = Math.ceil(over / (billingUnits > 0 ? billingUnits : 1))
		const unit = featureUnit(featureId)
		const rateLabel =
			billingUnits > 1
				? `${formatRate(rate)} / ${billingUnits.toLocaleString("en-US")} ${unit}s`
				: `${formatRate(rate)} / ${unit}`
		lines.push({
			key: `overage:${featureId}`,
			label: `${FEATURE_LABELS[featureId] ?? featureId} overage`,
			detail: `${formatQuantity(featureId, over)} over included × ${rateLabel}`,
			amount: units * rate,
		})
	}

	return {
		lines,
		total: lines.reduce((sum, line) => sum + line.amount, 0),
		currency: "usd",
		partial,
	}
}

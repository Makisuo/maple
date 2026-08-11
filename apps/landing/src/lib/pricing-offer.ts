/**
 * The single priced offer, resolved from Autumn.
 *
 * Lifted out of `PricingTable.astro` so the HTML pricing page and the
 * agent-readable `/pricing.md` twin render the same numbers by construction.
 * A second source of truth here would be a pricing page that disagrees with
 * itself depending on which representation a reader got.
 *
 * **Messages are called inside the exported functions, never at module scope.**
 * Paraglide resolves the active locale per call through an AsyncLocalStorage the
 * astro integration sets up around each page render (see `page-registry.ts`
 * rule 1). Module scope evaluates once per build, so a module-level
 * `label: m.pricing_logs()` freezes whichever locale rendered first and every
 * other locale inherits it.
 */
import { Autumn } from "autumn-js"
import * as m from "../paraglide/messages"

const AUTUMN_API_VERSION = "2.3.0"

/** browser_sessions is metered per session; every other signal is per GB. */
type Unit = "gb" | "count"

export interface Allotment {
	featureId: string
	label: string
	unit: Unit
	included: number
	/** Price per unit once `included` is used up. */
	rate?: number
}

export interface Offer {
	name: string
	price: number
	interval?: string
	hasTrial: boolean
	trialDuration?: number
	allotments: Allotment[]
	ctaLabel: string
}

const HIDDEN_FEATURE_IDS = new Set<string>(["ai_input_tokens", "ai_output_tokens"])

/** Canonical row order — Autumn can return items in any order. */
const DATA_FEATURE_ORDER = ["logs", "traces", "metrics", "browser_sessions"]

const dataFeatureRank = (id: string | undefined) => {
	const i = id ? DATA_FEATURE_ORDER.indexOf(id) : -1
	return i === -1 ? DATA_FEATURE_ORDER.length : i
}

const unitFor = (featureId: string): Unit => (featureId === "browser_sessions" ? "count" : "gb")

/**
 * Capitalized, localized labels for the metered rows, keyed by Autumn featureId
 * (Autumn returns lowercase names like "logs").
 */
const dataFeatureLabels = (): Record<string, string> => ({
	logs: m.pricing_logs(),
	traces: m.pricing_traces(),
	metrics: m.pricing_metrics(),
	browser_sessions: m.nav_browser_sessions(),
})

/**
 * Everything the plan carries, as one run. With a single plan there is nothing
 * to compare against, so this is a "and all of this too" line rather than a
 * checklist — a checklist implies some rows might have been withheld.
 */
export const platformFeatures = (): string[] => [
	m.pricing_30day_retention(),
	m.pricing_private_channel(),
	m.pricing_unlimited_dashboards(),
	m.pricing_advanced_alerting(),
	m.pricing_mcp_server(),
	m.pricing_ai_chat(),
	m.pricing_ai_triage(),
	m.pricing_full_api(),
]

/**
 * The live offer, or the `autumn.config.ts` mirror if Autumn is unreachable at
 * build time. The fallback carries browser sessions too — a short fallback
 * would render a meter that disagrees with the live one.
 */
export async function getOffer(): Promise<Offer> {
	const labels = dataFeatureLabels()

	try {
		const autumn = new Autumn({
			secretKey: import.meta.env.AUTUMN_SECRET_KEY,
			xApiVersion: AUTUMN_API_VERSION,
		})
		const result = await autumn.plans.list()
		const products = (result.list ?? []).filter((p) => !p.addOn)

		if (products.length > 1) {
			// The layout renders one offer. A second tier must fail loudly at build
			// time rather than silently vanishing off the pricing page.
			console.warn(
				`[pricing-offer] Autumn returned ${products.length} non-add-on plans (${products
					.map((p) => p.id)
					.join(", ")}); only the first is rendered. Update PricingTable for multiple tiers.`,
			)
		}

		const product = products[0]

		if (product) {
			return {
				name: product.name,
				price: product.price?.amount ?? 0,
				interval: product.price?.interval ? `/${product.price.interval}` : undefined,
				hasTrial: !!product.freeTrial,
				trialDuration: product.freeTrial?.durationLength,
				allotments: product.items
					.filter((item) => item.featureId && !HIDDEN_FEATURE_IDS.has(item.featureId))
					.map((item) => {
						const featureId = item.featureId as string
						return {
							featureId,
							label: labels[featureId] ?? item.feature?.name ?? featureId,
							unit: unitFor(featureId),
							included: Number(item.included ?? 0),
							rate: item.price?.amount ?? undefined,
						}
					})
					.sort((a, b) => dataFeatureRank(a.featureId) - dataFeatureRank(b.featureId)),
				ctaLabel: product.freeTrial
					? m.pricing_start_trial({ duration: String(product.freeTrial.durationLength) })
					: m.cta_get_started(),
			}
		}
	} catch (e) {
		console.error("Failed to fetch pricing from Autumn:", e)
	}

	return {
		name: "Startup",
		price: 39,
		interval: "/month",
		hasTrial: true,
		trialDuration: 14,
		allotments: [
			{ featureId: "logs", label: labels.logs!, unit: "gb", included: 100, rate: 0.3 },
			{ featureId: "traces", label: labels.traces!, unit: "gb", included: 100, rate: 0.3 },
			{ featureId: "metrics", label: labels.metrics!, unit: "gb", included: 100, rate: 0.3 },
			{
				featureId: "browser_sessions",
				label: labels.browser_sessions!,
				unit: "count",
				included: 5000,
				rate: 0.002,
			},
		],
		ctaLabel: m.pricing_start_trial({ duration: "14" }),
	}
}

// ── Formatting ───────────────────────────────────────────────────────────────
// Every number on the pricing surface is money or volume, so it all runs
// through one of these three.

const round2 = (n: number) => Math.round(n * 100) / 100

export const money = (n: number) => {
	const r = round2(n)
	return Number.isInteger(r) ? `$${r}` : `$${r.toFixed(2)}`
}

/** Sub-cent rates (per session) need three places; per-GB rates need two. */
export const rateLabel = (n: number) => `$${n < 0.01 ? n.toFixed(3) : n.toFixed(2)}`

export const volume = (a: Allotment, n: number) => (a.unit === "gb" ? `${n} GB` : n.toLocaleString("en-US"))

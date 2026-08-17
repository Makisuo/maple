import { feature, plan } from "atmn"

// Features
export const logs = feature({
	id: "logs",
	name: "Logs",
	type: "metered",
	consumable: true,
})

export const metrics = feature({
	id: "metrics",
	name: "Metrics",
	type: "metered",
	consumable: true,
})

export const traces = feature({
	id: "traces",
	name: "Traces",
	type: "metered",
	consumable: true,
})

export const browserSessions = feature({
	id: "browser_sessions",
	name: "Browser Sessions",
	type: "metered",
	consumable: true,
})

// Product events (`track()` calls, `/v1/events` rows) — unit is one event.
// Metered by the ingest gateway on both paths (see `PRODUCT_EVENTS_FEATURE_ID`
// in apps/ingest/src/main.rs).
export const productEvents = feature({
	id: "product_events",
	name: "Product Events",
	type: "metered",
	consumable: true,
})

export const aiInputTokens = feature({
	id: "ai_input_tokens",
	name: "AI Input Tokens",
	type: "metered",
	consumable: true,
})

export const aiOutputTokens = feature({
	id: "ai_output_tokens",
	name: "AI Output Tokens",
	type: "metered",
	consumable: true,
})

export const bringYourOwnCloud = feature({
	id: "bringyourowncloud",
	name: "Bring Your Own Cloud",
	type: "boolean",
})

export const startup = plan({
	id: "startup",
	name: "Startup",
	price: {
		amount: 39,
		interval: "month",
	},
	items: [
		{
			featureId: "logs",
			included: 100,
			price: {
				amount: 0.3,
				billingUnits: 1,
				billingMethod: "usage_based",
				interval: "month",
			},
		},
		{
			featureId: "metrics",
			included: 100,
			price: {
				amount: 0.3,
				billingUnits: 1,
				billingMethod: "usage_based",
				interval: "month",
			},
		},
		{
			featureId: "traces",
			included: 100,
			price: {
				amount: 0.3,
				billingUnits: 1,
				billingMethod: "usage_based",
				interval: "month",
			},
		},
		{
			featureId: "browser_sessions",
			included: 5000,
			price: {
				amount: 0.002,
				billingUnits: 1,
				billingMethod: "usage_based",
				interval: "month",
			},
		},
		{
			featureId: "product_events",
			included: 1_000_000,
			// PLACEHOLDER price, chosen 2026-08-17: $0.05 per 1,000 events past the
			// first 1M/month (PostHog-style order of magnitude). `amount` is the
			// price per `billingUnits` in atmn, so 0.05 / 1000 = $0.00005 per event.
			// To be confirmed before the plan is pushed to production.
			price: {
				amount: 0.05,
				billingUnits: 1000,
				billingMethod: "usage_based",
				interval: "month",
			},
		},
	],
	freeTrial: {
		durationLength: 14,
		durationType: "day",
		cardRequired: true,
	},
})

export const bringYourOwnCloudAddOn = plan({
	id: "bringyourowncloud",
	name: "Bring Your Own Cloud",
	addOn: true,
	price: {
		amount: 99,
		interval: "month",
	},
	items: [
		{
			featureId: "bringyourowncloud",
		},
	],
})

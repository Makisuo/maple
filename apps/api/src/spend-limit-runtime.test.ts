import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import type { SpendLimits } from "@maple/domain/http"
import { SpendLimits as SpendLimitsClass } from "@maple/domain/http"
import { evaluateOrg } from "./spend-limit-runtime"
import type { makeCallAutumn } from "./lib/autumn-client"
import type { ConfiguredSpendLimits, SpendEvaluationRecord } from "./services/billing/SpendLimitsService"

// What the cron writes back is the whole contract with the gateway: `breached`
// becomes `pausedAt` and `exceededCaps` becomes `pausedFeatures`, both read on
// every ingest request. These tests pin what may and may not be written.

const startupPlan = {
	id: "startup",
	name: "Startup",
	price: { amount: 39, interval: "month" },
	items: [
		{ featureId: "logs", included: 100, price: { amount: 0.3 } },
		{ featureId: "traces", included: 100, price: { amount: 0.3 } },
		{ featureId: "metrics", included: 100, price: { amount: 0.3 } },
		{ featureId: "browser_sessions", included: 5_000, price: { amount: 0.002 } },
	],
}

const customer = (planId: string) => ({
	id: "org_1",
	subscriptions: [{ planId, status: "active" }],
	balances: {
		logs: { granted: 100 },
		traces: { granted: 100 },
		metrics: { granted: 100 },
		browser_sessions: { granted: 5_000 },
	},
})

// $199.40: $39 base + 290 GB logs, 40 GB traces, 60 GB metrics, 21,700 sessions.
const usage = {
	total: {
		logs: { sum: 390 },
		traces: { sum: 140 },
		metrics: { sum: 160 },
		browser_sessions: { sum: 26_700 },
	},
}

const limits = (overrides: Partial<SpendLimits> = {}) =>
	new SpendLimitsClass({
		monthlyLimitCents: 10_000, // $100 — the $199.40 above breaches it
		enforcementMode: "pause",
		alertThresholdPercents: [80, 100],
		featureCaps: { logs: 300 }, // 390 GB of logs is over this
		lastEvaluatedAt: null,
		evaluatedSpendCents: null,
		breachedAt: null,
		pausedAt: null,
		pausedFeatures: [],
		...overrides,
	})

const entry = (overrides: Partial<ConfiguredSpendLimits> = {}): ConfiguredSpendLimits => ({
	orgId: "org_1",
	limits: limits(),
	notifiedThresholds: [],
	cycleStartedAtMs: null,
	...overrides,
})

/**
 * Run `evaluateOrg` against a stubbed Autumn and capture what it wrote.
 * `planId` selects the customer's plan: "startup" prices fully, anything else
 * has no catalog entry and so produces a `partial` (lower-bound) estimate.
 */
const runEvaluation = async (planId: string, configured = entry()) => {
	const recorded: SpendEvaluationRecord[] = []

	const callAutumn: ReturnType<typeof makeCallAutumn> = (route) =>
		Effect.succeed({
			statusCode: 200,
			response:
				route === "getOrCreateCustomer"
					? customer(planId)
					: route === "listPlans"
						? { list: [startupPlan] }
						: usage,
		})

	await Effect.runPromise(
		evaluateOrg(configured, {
			// Pass-through cache: exercises the real readCustomerCached wrapper
			// without needing a cache backend.
			edgeCache: {
				getOrCompute: (_options, compute) =>
					compute.pipe(Effect.map((value) => ({ value, hit: false }))),
			},
			callAutumn,
			spendLimits: {
				recordEvaluation: (_orgId, evaluation) =>
					Effect.sync(() => {
						recorded.push(evaluation)
					}),
			},
		}),
	)

	expect(recorded).toHaveLength(1)
	return recorded[0]!
}

describe("evaluateOrg", () => {
	it("pauses and records exceeded caps when the estimate is complete", async () => {
		const recorded = await runEvaluation("startup")

		expect(recorded.breached).toBe(true)
		expect(recorded.exceededCaps).toEqual(["logs"])
	})

	it("pauses nothing — ceiling or cap — on a partial estimate", async () => {
		// A plan absent from the catalog can't be priced, so the spend number is
		// a lower bound. The ceiling already refused to act on it; the per-feature
		// caps must refuse too, or a cap pauses on the very number the ceiling
		// won't trust.
		const recorded = await runEvaluation("legacy_pro")

		expect(recorded.breached).toBe(false)
		expect(recorded.exceededCaps).toEqual([])
	})

	it("never records a threshold as notified while delivery is unwired", async () => {
		// Stamping an unsent notification means the first org to cross a
		// threshold is skipped forever once delivery lands.
		const recorded = await runEvaluation("startup", entry({ notifiedThresholds: [80] }))

		expect(recorded.notifiedThresholds).toEqual([])
	})
})

import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { BillingCustomer, BillingUsage } from "@maple/domain/http"
import { decodeUpstream, ensureOk } from "@/services/billing/autumn-client"
import {
	camelizeKeys,
	makeAutumnClient,
	type AutumnClient,
	type AutumnResult,
} from "@/services/billing/autumn-http"

const ORG = "org_test_123"
const KEY = "am_sk_test"
const API_URL = "https://api.useautumn.com"

interface Captured {
	readonly url: string
	readonly method: string
	readonly headers: Headers
	readonly body: unknown
}

/**
 * Substitute the fetch the client transport calls.
 *
 * `FetchHttpClient` reads its fetch from the `Fetch` context reference, whose
 * `globalThis.fetch` default is memoized on first read — so swapping
 * `globalThis.fetch` per test would silently keep serving the FIRST test's stub.
 * Providing the reference is the order-independent seam. (The layer itself stays
 * inline in the client, which is what keeps `readCustomerCached`'s
 * `Effect<AutumnResult, BillingUpstreamError>` free of an `HttpClient`
 * requirement.)
 */
const provideFetch = <A, E>(effect: Effect.Effect<A, E>, fetch: typeof globalThis.fetch) =>
	Effect.provideService(effect, FetchHttpClient.Fetch, fetch)

const withFetch = async (
	respond: { readonly status?: number; readonly body?: string },
	run: (client: AutumnClient) => Effect.Effect<AutumnResult, unknown>,
): Promise<{ readonly captured: Captured | undefined; readonly result: AutumnResult }> => {
	let captured: Captured | undefined
	const fetch = (async (input, init) => {
		const text =
			init?.body === undefined || init.body === null ? "" : await new Response(init.body).text()
		captured = {
			url: String(input),
			method: String(init?.method),
			headers: new Headers(init?.headers),
			body: text.length === 0 ? undefined : JSON.parse(text),
		}
		return new Response(respond.body ?? JSON.stringify({}), { status: respond.status ?? 200 })
	}) as typeof globalThis.fetch

	const result = await Effect.runPromise(provideFetch(run(makeAutumnClient(KEY, API_URL)), fetch))
	return { captured, result }
}

describe("makeAutumnClient request construction", () => {
	it("getOrCreateCustomer posts to customers.get_or_create and always appends balances.feature", async () => {
		const { captured } = await withFetch({}, (autumn) =>
			autumn.getOrCreateCustomer(ORG, { expand: ["subscriptions.plan"] }),
		)

		assert.strictEqual(captured?.url, "https://api.useautumn.com/v1/customers.get_or_create")
		assert.strictEqual(captured?.method, "POST")
		assert.strictEqual(captured?.headers.get("authorization"), `Bearer ${KEY}`)
		assert.strictEqual(captured?.headers.get("content-type"), "application/json")
		assert.strictEqual(captured?.headers.get("accept"), "application/json")
		// The SDK sent no x-api-version on the RPC routes; neither do we.
		assert.isNull(captured?.headers.get("x-api-version") ?? null)
		assert.deepStrictEqual(captured?.body, {
			customer_id: ORG,
			expand: ["subscriptions.plan", "balances.feature"],
		})
	})

	it("getOrCreateCustomer keeps the invoices expand alongside the appended one", async () => {
		const { captured } = await withFetch({}, (autumn) =>
			autumn.getOrCreateCustomer(ORG, { expand: ["invoices"] }),
		)
		assert.deepStrictEqual(captured?.body, {
			customer_id: ORG,
			expand: ["invoices", "balances.feature"],
		})
	})

	it("getOrCreateCustomer forwards customer identity fields when supplied", async () => {
		const { captured } = await withFetch({}, (autumn) =>
			autumn.getOrCreateCustomer(ORG, {
				expand: [],
				customerData: {
					email: "dev@maple.dev",
					name: "Maple",
					fingerprint: ORG,
					metadata: { maple_user_id: "user_1" },
				},
			}),
		)
		assert.deepStrictEqual(captured?.body, {
			customer_id: ORG,
			email: "dev@maple.dev",
			name: "Maple",
			fingerprint: ORG,
			metadata: { maple_user_id: "user_1" },
			expand: ["balances.feature"],
		})
	})

	it("aggregateEvents sends the SDK's bin_size default", async () => {
		const { captured } = await withFetch({ body: JSON.stringify({ total: {} }) }, (autumn) =>
			autumn.aggregateEvents(ORG, { featureId: ["logs", "traces"], range: "30d" }),
		)
		assert.strictEqual(captured?.url, "https://api.useautumn.com/v1/events.aggregate")
		assert.deepStrictEqual(captured?.body, {
			customer_id: ORG,
			feature_id: ["logs", "traces"],
			range: "30d",
			bin_size: "day",
		})
	})

	it("attach sends the SDK's redirect_mode default and NO customer_data", async () => {
		const { captured } = await withFetch({}, (autumn) => autumn.attach(ORG, { planId: "startup" }))
		assert.strictEqual(captured?.url, "https://api.useautumn.com/v1/billing.attach")
		assert.deepStrictEqual(captured?.body, {
			customer_id: ORG,
			plan_id: "startup",
			redirect_mode: "if_required",
		})
	})

	it("previewAttach hits preview_attach with the same defaults", async () => {
		const { captured } = await withFetch({}, (autumn) => autumn.previewAttach(ORG, { planId: "startup" }))
		assert.strictEqual(captured?.url, "https://api.useautumn.com/v1/billing.preview_attach")
		assert.deepStrictEqual(captured?.body, {
			customer_id: ORG,
			plan_id: "startup",
			redirect_mode: "if_required",
		})
	})

	it("openCustomerPortal omits return_url entirely when there is none", async () => {
		const withUrl = await withFetch({}, (autumn) =>
			autumn.openCustomerPortal(ORG, { returnUrl: "https://web.maple.dev/settings/billing" }),
		)
		assert.strictEqual(withUrl.captured?.url, "https://api.useautumn.com/v1/billing.open_customer_portal")
		assert.deepStrictEqual(withUrl.captured?.body, {
			customer_id: ORG,
			return_url: "https://web.maple.dev/settings/billing",
		})

		const without = await withFetch({}, (autumn) =>
			autumn.openCustomerPortal(ORG, { returnUrl: undefined }),
		)
		assert.deepStrictEqual(without.captured?.body, { customer_id: ORG })
	})

	it("listPlans omits customer_id for an unauthenticated caller", async () => {
		const authed = await withFetch({ body: JSON.stringify({ list: [] }) }, (autumn) =>
			autumn.listPlans(ORG),
		)
		assert.strictEqual(authed.captured?.url, "https://api.useautumn.com/v1/plans.list")
		assert.deepStrictEqual(authed.captured?.body, { customer_id: ORG })

		const anonymous = await withFetch({ body: JSON.stringify({ list: [] }) }, (autumn) =>
			autumn.listPlans(undefined),
		)
		assert.deepStrictEqual(anonymous.captured?.body, {})
	})

	it("strips trailing slashes from the configured API url", async () => {
		let url: string | undefined
		const fetch = (async (input) => {
			url = String(input)
			return new Response("{}", { status: 200 })
		}) as typeof globalThis.fetch

		await Effect.runPromise(
			provideFetch(makeAutumnClient(KEY, "https://api.useautumn.com/").listPlans(undefined), fetch),
		)
		assert.strictEqual(url, "https://api.useautumn.com/v1/plans.list")
	})

	it("fails with BillingUpstreamError when no secret key is configured", async () => {
		const exit = await Effect.runPromiseExit(makeAutumnClient(undefined, API_URL).listPlans(undefined))
		assert.isTrue(exit._tag === "Failure")
	})
})

describe("makeAutumnClient response handling", () => {
	it("camelizes a realistic customer payload while preserving feature-keyed records", async () => {
		const wire = {
			id: ORG,
			created_at: 1_750_000_000_000,
			stripe_id: "cus_1",
			billing_controls: {
				spend_limits: [
					{ feature_id: "logs", enabled: true, limit_type: "absolute", overage_limit: 250 },
				],
				usage_alerts: [
					{ feature_id: "logs", enabled: true, threshold: 80, threshold_type: "usage_percentage" },
				],
			},
			subscriptions: [
				{
					plan_id: "startup",
					status: "active",
					add_on: false,
					past_due: false,
					trial_ends_at: null,
					current_period_start: 1_750_000_000_000,
					current_period_end: 1_752_000_000_000,
					plan: {
						id: "startup",
						name: "Startup",
						items: [
							{
								feature_id: "logs",
								included: 100,
								price: { amount: 0.3, interval: "month", billing_units: 1 },
								display: { primary_text: "100 GB", secondary_text: "then $0.30/GB" },
							},
						],
					},
				},
			],
			balances: {
				browser_sessions: { feature_id: "browser_sessions", granted: 100, overage_allowed: true },
				ai_input_tokens: { feature_id: "ai_input_tokens", granted: 5, overage_allowed: false },
			},
			flags: { ai_beta: { feature_id: "ai_beta", plan_id: null } },
			metadata: { maple_user_id: "user_1" },
			invoices: [
				{
					stripe_id: "in_1",
					plan_ids: ["startup"],
					status: "paid",
					total: 42.3,
					currency: "usd",
					created_at: 1_750_000_000_000,
					hosted_invoice_url: "https://invoice.stripe.com/i/in_1",
				},
			],
		}

		const { result } = await withFetch({ body: JSON.stringify(wire) }, (autumn) =>
			autumn.getOrCreateCustomer(ORG, { expand: ["subscriptions.plan", "invoices"] }),
		)

		assert.strictEqual(result.statusCode, 200)
		// Asserted whole so a rename drift can't hide in an unchecked corner. Note
		// `balances` / `flags` / `metadata` keys: those are DATA (feature ids),
		// and mangling them would break every feature lookup.
		assert.deepStrictEqual(result.response, {
			id: ORG,
			createdAt: 1_750_000_000_000,
			stripeId: "cus_1",
			billingControls: {
				spendLimits: [{ featureId: "logs", enabled: true, limitType: "absolute", overageLimit: 250 }],
				usageAlerts: [
					{ featureId: "logs", enabled: true, threshold: 80, thresholdType: "usage_percentage" },
				],
			},
			subscriptions: [
				{
					planId: "startup",
					status: "active",
					addOn: false,
					pastDue: false,
					trialEndsAt: null,
					currentPeriodStart: 1_750_000_000_000,
					currentPeriodEnd: 1_752_000_000_000,
					plan: {
						id: "startup",
						name: "Startup",
						items: [
							{
								featureId: "logs",
								included: 100,
								price: { amount: 0.3, interval: "month", billingUnits: 1 },
								display: { primaryText: "100 GB", secondaryText: "then $0.30/GB" },
							},
						],
					},
				},
			],
			balances: {
				browser_sessions: { featureId: "browser_sessions", granted: 100, overageAllowed: true },
				ai_input_tokens: { featureId: "ai_input_tokens", granted: 5, overageAllowed: false },
			},
			flags: { ai_beta: { featureId: "ai_beta", planId: null } },
			metadata: { maple_user_id: "user_1" },
			invoices: [
				{
					stripeId: "in_1",
					planIds: ["startup"],
					status: "paid",
					total: 42.3,
					currency: "usd",
					createdAt: 1_750_000_000_000,
					hostedInvoiceUrl: "https://invoice.stripe.com/i/in_1",
				},
			],
		})

		// …and the camelized payload decodes straight into the domain schema.
		const customer = await Effect.runPromise(
			ensureOk(result).pipe(Effect.flatMap((body) => decodeUpstream(BillingCustomer, body))),
		)
		assert.strictEqual(customer.id, ORG)
		assert.strictEqual(customer.subscriptions[0]?.planId, "startup")
		assert.strictEqual(customer.balances?.browser_sessions?.granted, 100)
	})

	it("keeps aggregateEvents' feature-keyed totals verbatim", async () => {
		const { result } = await withFetch(
			{
				body: JSON.stringify({
					list: [{ period: 1_750_000_000_000, values: { ai_input_tokens: 12 } }],
					total: { ai_input_tokens: { count: 120, sum: 4.2 } },
				}),
			},
			(autumn) => autumn.aggregateEvents(ORG, { featureId: ["ai_input_tokens"], range: "30d" }),
		)
		assert.deepStrictEqual(result.response, {
			list: [{ period: 1_750_000_000_000, values: { ai_input_tokens: 12 } }],
			total: { ai_input_tokens: { count: 120, sum: 4.2 } },
		})

		const usage = await Effect.runPromise(
			ensureOk(result).pipe(Effect.flatMap((body) => decodeUpstream(BillingUsage, body))),
		)
		assert.strictEqual(usage.total?.ai_input_tokens?.sum, 4.2)
	})

	it("passes a non-2xx through as a result carrying Autumn's own message", async () => {
		const { result } = await withFetch(
			{ status: 402, body: JSON.stringify({ message: "Card declined", code: "card_declined" }) },
			(autumn) => autumn.attach(ORG, { planId: "startup" }),
		)
		assert.deepStrictEqual(result, {
			statusCode: 402,
			response: { message: "Card declined", code: "card_declined", statusCode: 402 },
		})

		const exit = await Effect.runPromiseExit(ensureOk(result))
		assert.isTrue(exit._tag === "Failure")
	})

	it("does NOT fail open on a 5xx — the status survives so the cache refuses it", async () => {
		const { result } = await withFetch(
			{ status: 503, body: JSON.stringify({ message: "upstream unavailable" }) },
			(autumn) => autumn.getOrCreateCustomer(ORG, { expand: ["subscriptions.plan"] }),
		)
		assert.strictEqual(result.statusCode, 503)
		assert.deepStrictEqual(result.response, {
			message: "upstream unavailable",
			code: "autumn_api_error",
			statusCode: 503,
		})
	})

	it("leaves the message off a non-JSON error body so the caller's generic fallback wins", async () => {
		const { result } = await withFetch({ status: 502, body: "<html>bad gateway</html>" }, (autumn) =>
			autumn.listPlans(ORG),
		)
		assert.deepStrictEqual(result.response, { code: "autumn_api_error", statusCode: 502 })

		const error = await Effect.runPromise(Effect.flip(ensureOk(result)))
		assert.strictEqual(error.message, "Billing request failed (502)")
	})

	it("maps a transport failure to BillingUpstreamError, not a defect or a fake status", async () => {
		// The SDK turned a rejected fetch into a synthetic `555 Network Error`
		// response; a typed failure is strictly better.
		const fetch = (async () => {
			throw new TypeError("network down")
		}) as typeof globalThis.fetch

		const error = await Effect.runPromise(
			Effect.flip(
				provideFetch(makeAutumnClient(KEY, API_URL).getOrCreateCustomer(ORG, { expand: [] }), fetch),
			),
		)
		assert.strictEqual(error._tag, "@maple/http/errors/BillingUpstreamError")
	})
})

describe("camelizeKeys", () => {
	it("renames nested keys through arrays", () => {
		assert.deepStrictEqual(
			camelizeKeys({ line_items: [{ display_name: "x", next_cycle: { starts_at: 1 } }] }),
			{ lineItems: [{ displayName: "x", nextCycle: { startsAt: 1 } }] },
		)
	})

	it("leaves scalars, nulls and already-camel keys alone", () => {
		assert.deepStrictEqual(camelizeKeys({ paymentUrl: null, total: 5, currency: "usd" }), {
			paymentUrl: null,
			total: 5,
			currency: "usd",
		})
		assert.strictEqual(camelizeKeys(null), null)
		assert.strictEqual(camelizeKeys(7), 7)
	})

	it("protects record-keyed containers one level down, but not deeper", () => {
		assert.deepStrictEqual(
			camelizeKeys({ balances: { browser_sessions: { next_reset_at: 1, breakdown: [] } } }),
			{ balances: { browser_sessions: { nextResetAt: 1, breakdown: [] } } },
		)
	})
})

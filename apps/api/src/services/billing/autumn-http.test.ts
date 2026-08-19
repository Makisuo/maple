import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { BillingCustomer, BillingUsage } from "@maple/domain/http"
import { Env } from "@/platform/Env"
import { classifyAutumn, decodeUpstream, ensureOk } from "@/services/billing/autumn-client"
import {
	AutumnClient,
	type AutumnClientApi,
	type AutumnResult,
	camelizeKeys,
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

/** Everything `Env` needs to build, plus the billing keys under test. */
const testEnv = (autumn: Record<string, string>) =>
	Env.layer.pipe(
		Layer.provide(
			ConfigProvider.layer(
				ConfigProvider.fromUnknown({
					TINYBIRD_HOST: "https://api.tinybird.co",
					TINYBIRD_TOKEN: "test-token",
					MAPLE_AUTH_MODE: "self_hosted",
					MAPLE_ROOT_PASSWORD: "test-root-password",
					MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
					MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
					...autumn,
				}),
			),
		),
	)

const clientLayer = (autumn: Record<string, string> = { AUTUMN_SECRET_KEY: KEY, AUTUMN_API_URL: API_URL }) =>
	AutumnClient.layer.pipe(Layer.provide(testEnv(autumn)))

/**
 * Substitute the fetch the client transport calls.
 *
 * `FetchHttpClient` reads its fetch from the `Fetch` context reference, whose
 * `globalThis.fetch` default is memoized on first read — so swapping
 * `globalThis.fetch` per test would silently keep serving the FIRST test's stub.
 * Providing the reference is the order-independent seam, and it still reaches a
 * client built EARLIER by `AutumnClient.layer`: `FetchHttpClient.layer` merges
 * the request-time context over the layer-build one (`Context.merge(build,
 * input)` — `input` wins), and the fetch itself is read per request from the
 * running fiber. That indirection is also why the service's effects stay
 * `R = never`, which is what `readCustomerCached` requires.
 */
const provideFetch = <A, E>(effect: Effect.Effect<A, E>, fetch: typeof globalThis.fetch) =>
	Effect.provideService(effect, FetchHttpClient.Fetch, fetch)

/** Resolve the service from its layer, then run the call with the stub ambient. */
const runWithClient = <A, E>(
	fetch: typeof globalThis.fetch,
	run: (client: AutumnClientApi) => Effect.Effect<A, E>,
	layer = clientLayer(),
) =>
	Effect.gen(function* () {
		const autumn = yield* AutumnClient
		return yield* provideFetch(run(autumn), fetch)
	}).pipe(Effect.provide(layer))

const withFetch = async (
	respond: { readonly status?: number; readonly body?: string },
	run: (client: AutumnClientApi) => Effect.Effect<AutumnResult, unknown>,
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

	const result = await Effect.runPromise(runWithClient(fetch, run))
	// Pinned here rather than per-route so every call in this file asserts it:
	// `autumn-js`'s env schema DEFAULTED `AUTUMN_X_API_VERSION` to "2.3.0"
	// (`z._default(z.string(), "2.3.0")`), so production has always sent this
	// header on all six routes.
	assert.strictEqual(captured?.headers.get("x-api-version"), "2.3.0")
	return { captured, result }
}

describe("AutumnClient request construction", () => {
	it("getOrCreateCustomer posts to customers.get_or_create and always appends balances.feature", async () => {
		const { captured } = await withFetch({}, (autumn) =>
			autumn.getOrCreateCustomer(ORG, { expand: ["subscriptions.plan"] }),
		)

		assert.strictEqual(captured?.url, "https://api.useautumn.com/v1/customers.get_or_create")
		assert.strictEqual(captured?.method, "POST")
		assert.strictEqual(captured?.headers.get("authorization"), `Bearer ${KEY}`)
		assert.strictEqual(captured?.headers.get("content-type"), "application/json")
		assert.strictEqual(captured?.headers.get("accept"), "application/json")
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
			runWithClient(
				fetch,
				(autumn) => autumn.listPlans(undefined),
				clientLayer({ AUTUMN_SECRET_KEY: KEY, AUTUMN_API_URL: "https://api.useautumn.com/" }),
			),
		)
		assert.strictEqual(url, "https://api.useautumn.com/v1/plans.list")
	})

	it("builds the layer with no secret key, then fails each call with BillingUpstreamError", async () => {
		// Local dev runs unconfigured: a missing AUTUMN_SECRET_KEY must not fail
		// the layer (and so must not fail worker boot), only the calls.
		const fetch = (async () => new Response("{}", { status: 200 })) as typeof globalThis.fetch
		const error = await Effect.runPromise(
			runWithClient(
				fetch,
				(autumn) => Effect.flip(autumn.listPlans(undefined)),
				clientLayer({ AUTUMN_API_URL: API_URL }),
			),
		)
		// A missing key is a deployment fault, NOT an upstream one: reporting 502
		// here sent every investigation to Autumn for a call it never received.
		assert.strictEqual(error._tag, "@maple/http/errors/BillingNotConfiguredError")
		assert.strictEqual(error.message, "Billing is not configured")
	})
})

describe("AutumnClient response handling", () => {
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

		// Asserting only "it failed" is what let 402/409/429 collapse into one
		// opaque 502 unnoticed. Pin the classification itself.
		const classified = await Effect.runPromise(Effect.flip(classifyAutumn(result)))
		assert.strictEqual(classified._tag, "@maple/http/errors/BillingPaymentRequiredError")
		assert.strictEqual(classified.code, "card_declined")
		assert.strictEqual(classified.upstreamStatus, 402)
		assert.strictEqual(classified.message, "Card declined")

		// …and that a pure READ still reports 502, because there the same upstream
		// 4xx means we built a bad request, not that the caller did.
		const collapsed = await Effect.runPromise(Effect.flip(ensureOk(result)))
		assert.strictEqual(collapsed._tag, "@maple/http/errors/BillingUpstreamError")
		assert.include(collapsed.message, "card_declined")
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

	it("fails an empty 2xx body rather than reporting a hollow success", async () => {
		// The SDK's `JSON.parse("")` threw and the call surfaced as a synthetic
		// 500 → 502. A `{}` here would decode as a valid all-optional
		// `AttachResult` — a 200 checkout with no payment URL — and would poison
		// the customer cache on the other routes.
		const fetch = (async () => new Response("", { status: 200 })) as typeof globalThis.fetch

		const error = await Effect.runPromise(
			runWithClient(fetch, (autumn) => Effect.flip(autumn.attach(ORG, { planId: "startup" }))),
		)
		assert.strictEqual(error._tag, "@maple/http/errors/BillingUpstreamError")
		assert.include(error.message, "attach")
		assert.include(error.message, "empty body")
	})

	it("keeps 204 as an explicit null body", async () => {
		const fetch = (async () => new Response(null, { status: 204 })) as typeof globalThis.fetch

		const result = await Effect.runPromise(
			runWithClient(fetch, (autumn) => autumn.attach(ORG, { planId: "startup" })),
		)
		assert.deepStrictEqual(result, { statusCode: 204, response: null })
	})

	it("maps a transport failure to BillingUpstreamError, not a defect or a fake status", async () => {
		// The SDK turned a rejected fetch into a synthetic `555 Network Error`
		// response; a typed failure is strictly better.
		const fetch = (async () => {
			throw new TypeError("network down")
		}) as typeof globalThis.fetch

		const error = await Effect.runPromise(
			runWithClient(fetch, (autumn) => Effect.flip(autumn.getOrCreateCustomer(ORG, { expand: [] }))),
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

	it("protects a model record's own keys, then camelizes the model under them", () => {
		assert.deepStrictEqual(
			camelizeKeys({ balances: { browser_sessions: { next_reset_at: 1, breakdown: [] } } }),
			{ balances: { browser_sessions: { nextResetAt: 1, breakdown: [] } } },
		)
	})

	it("camelizes model arrays nested under a model record (the SDK remapped them)", () => {
		assert.deepStrictEqual(
			camelizeKeys({
				balances: { ai_input_tokens: { breakdown: [{ plan_id: "startup", included_grant: 5 }] } },
			}),
			{ balances: { ai_input_tokens: { breakdown: [{ planId: "startup", includedGrant: 5 }] } } },
		)
	})

	it("passes free-form metadata through verbatim at every depth", () => {
		// `metadata` is `record(string, any)` in the SDK — it never descended, so
		// renaming a user's own keys here would corrupt their data.
		assert.deepStrictEqual(camelizeKeys({ metadata: { user_prefs: { some_flag: true } } }), {
			metadata: { user_prefs: { some_flag: true } },
		})
	})

	it("renames grouped_values itself but leaves both levels of keys under it", () => {
		// `record(string, record(string, number))`: feature id outside, group label
		// inside. Both are data; only the field's own key is schema.
		assert.deepStrictEqual(camelizeKeys({ grouped_values: { ai_input_tokens: { some_group: 3 } } }), {
			groupedValues: { ai_input_tokens: { some_group: 3 } },
		})
	})

	it("leaves anything under values verbatim", () => {
		assert.deepStrictEqual(camelizeKeys({ values: { ai_input_tokens: 12, some_group: [{ a_b: 1 }] } }), {
			values: { ai_input_tokens: 12, some_group: [{ a_b: 1 }] },
		})
	})
})

describe("classifyAutumn", () => {
	const rejection = (statusCode: number, code = "some_code"): AutumnResult => ({
		statusCode,
		response: { message: "nope", code, statusCode },
	})

	// The status class is the contract. Autumn's `code` rides along as context and
	// is deliberately NOT what we branch on — they own that vocabulary and can add
	// to it, and a `Schema.Literals` union here would turn a new code into a decode
	// failure, trading a legible 4xx for an opaque 500.
	const cases = [
		[402, "@maple/http/errors/BillingPaymentRequiredError"],
		[409, "@maple/http/errors/BillingConflictError"],
		[429, "@maple/http/errors/BillingRateLimitedError"],
		// An auth rejection is our revoked/rotated key, not a bad request from the
		// caller — and it has to stay 5xx so a total checkout outage keeps counting
		// as an error rather than recording as an Ok 4xx span.
		[401, "@maple/http/errors/BillingNotConfiguredError"],
		[403, "@maple/http/errors/BillingNotConfiguredError"],
		[400, "@maple/http/errors/BillingRequestError"],
		[404, "@maple/http/errors/BillingRequestError"],
		[422, "@maple/http/errors/BillingRequestError"],
		[500, "@maple/http/errors/BillingUpstreamError"],
		[503, "@maple/http/errors/BillingUpstreamError"],
	] as const

	for (const [status, tag] of cases) {
		it(`maps HTTP ${status} to ${tag.split("/").pop()}`, async () => {
			const error = await Effect.runPromise(Effect.flip(classifyAutumn(rejection(status))))
			assert.strictEqual(error._tag, tag)
		})
	}

	it("carries Autumn's own code verbatim, including one we've never seen", async () => {
		const error = await Effect.runPromise(
			Effect.flip(classifyAutumn(rejection(409, "a_code_autumn_invented_yesterday"))),
		)
		assert.strictEqual(error._tag, "@maple/http/errors/BillingConflictError")
		assert.strictEqual("code" in error ? error.code : undefined, "a_code_autumn_invented_yesterday")
	})

	it("keeps an auth rejection out of the caller-blaming 400 bucket on reads too", async () => {
		// `ensureOk` collapses caller-input 4xx into 502; a credentials fault must
		// pass through untouched so it stays distinguishable from "Autumn is down".
		const error = await Effect.runPromise(Effect.flip(ensureOk(rejection(401, "unauthorized"))))
		assert.strictEqual(error._tag, "@maple/http/errors/BillingNotConfiguredError")
	})

	it("passes a 2xx body straight through", async () => {
		const body = await Effect.runPromise(classifyAutumn({ statusCode: 200, response: { ok: 1 } }))
		assert.deepStrictEqual(body, { ok: 1 })
	})

	it("collapses every classified 4xx back to 502 under ensureOk, keeping the status in the message", async () => {
		for (const [status] of cases.filter(([code]) => code < 500 && code !== 401 && code !== 403)) {
			const error = await Effect.runPromise(Effect.flip(ensureOk(rejection(status))))
			assert.strictEqual(error._tag, "@maple/http/errors/BillingUpstreamError")
			assert.include(error.message, String(status))
		}
	})
})

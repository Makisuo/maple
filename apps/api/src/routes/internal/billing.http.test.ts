import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Context, Effect, Layer, Schema } from "effect"
import { FetchHttpClient, HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import {
	EdgeCacheService,
	type EdgeCacheBackend,
	makeEdgeCacheService,
	makeMemoryBackend,
} from "@maple/cache"
import { Env } from "@/platform/Env"
import {
	CUSTOMER_CACHE_BUCKET,
	CUSTOMER_CACHE_TTL_SECONDS,
	CUSTOMER_CACHE_LAPSED_TTL_SECONDS,
	CUSTOMER_CACHE_UNSETTLED_TTL_SECONDS,
	readCustomerCached,
	resolveAttachConflict,
	responseHasActivePlan,
	responseHasPlanHistory,
	summariseSubscriptions,
} from "@/services/billing/autumn-client"
import { AutumnClient, type AutumnResult } from "@/services/billing/autumn-http"
import {
	BillingApiGroup,
	BillingConflictError,
	BillingCustomer,
	CurrentTenant,
	V1SchemaErrors,
	V1UnexpectedErrors,
	UpdateBillingControlsRequest,
	UpdateBillingSpendLimit,
	UpdateBillingUsageAlert,
} from "@maple/domain/http"
import { DailySpendService } from "@/services/billing/DailySpendService"
import { ProductEventsService } from "@/services/product-events/ProductEventsService"
import { StripeClient } from "@/services/billing/stripe-http"
import { decodeInvoices, HttpBillingLive, resolveCycleWindow } from "./billing.http"
import { V1ErrorBoundaryLive } from "../v1/error-boundary"

const ORG = "org_test_123"

const makeCache = () => makeEdgeCacheService(makeMemoryBackend())

// Wrap the real memory backend so caching/expiry still works, but record the
// TTL handed to each `put` — lets us assert the content-dependent TTL policy.
const makeRecordingBackend = () => {
	const inner = makeMemoryBackend()
	const puts: number[] = []
	const backend: EdgeCacheBackend = {
		name: inner.name,
		get: inner.get,
		put: (bucket, hash, value, ttlSeconds, nowMs) => {
			puts.push(ttlSeconds)
			return inner.put(bucket, hash, value, ttlSeconds, nowMs)
		},
		delete: inner.delete,
	}
	return { cache: makeEdgeCacheService(backend), puts }
}

const activePlanResponse = {
	id: ORG,
	subscriptions: [{ planId: "startup", status: "active", trialEndsAt: 9_999_999_999_000, addOn: false }],
}
const noPlanResponse = { id: ORG, subscriptions: [] }
const lapsedPlanResponse = {
	id: ORG,
	subscriptions: [{ planId: "startup", status: "expired", addOn: false }],
}

// `AutumnClient` reads its credentials from `Env` and captures the HttpClient at
// layer build; the fetch stub is provided as the `FetchHttpClient.Fetch`
// reference (order-independent — swapping `globalThis.fetch` races the
// reference's memoized default).
const autumnClientLayer = AutumnClient.layer.pipe(
	Layer.provide(
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
						AUTUMN_SECRET_KEY: "am_sk_test",
						AUTUMN_API_URL: "https://api.useautumn.com/",
					}),
				),
			),
		),
	),
)

describe("AutumnClient.updateCustomerBillingControls", () => {
	it("uses Autumn's canonical customer update route and v2.3 wire shape", async () => {
		let request: { readonly url: string; readonly init?: RequestInit } | undefined
		const fetch = (async (input, init) => {
			request = { url: String(input), init }
			return new Response(JSON.stringify({ id: ORG }), { status: 200 })
		}) as typeof globalThis.fetch

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const autumn = yield* AutumnClient
				return yield* autumn
					.updateCustomerBillingControls(
						ORG,
						new UpdateBillingControlsRequest({
							spendLimits: [
								new UpdateBillingSpendLimit({
									featureId: "logs",
									enabled: true,
									limitType: "absolute",
									overageLimit: 250,
								}),
								new UpdateBillingSpendLimit({
									featureId: "traces",
									enabled: false,
								}),
							],
							usageAlerts: [
								new UpdateBillingUsageAlert({
									featureId: "logs",
									enabled: true,
									threshold: 80,
									thresholdType: "usage_percentage",
									name: "Maple billing warning",
								}),
							],
						}),
					)
					.pipe(Effect.provideService(FetchHttpClient.Fetch, fetch))
			}).pipe(Effect.provide(autumnClientLayer)),
		)

		assert.strictEqual(result.statusCode, 200)
		// The configured AUTUMN_API_URL carries a trailing slash — it must not
		// survive into the path.
		assert.strictEqual(request?.url, "https://api.useautumn.com/v1/customers.update")
		assert.strictEqual(request?.init?.method, "POST")
		const headers = new Headers(request?.init?.headers)
		assert.strictEqual(headers.get("authorization"), "Bearer am_sk_test")
		assert.strictEqual(headers.get("content-type"), "application/json")
		assert.strictEqual(headers.get("x-api-version"), "2.3.0")
		const requestBody = await new Response(request?.init?.body).text()
		assert.deepStrictEqual(JSON.parse(requestBody), {
			customer_id: ORG,
			billing_controls: {
				spend_limits: [
					{
						feature_id: "logs",
						enabled: true,
						limit_type: "absolute",
						overage_limit: 250,
					},
					{
						feature_id: "traces",
						enabled: false,
					},
				],
				usage_alerts: [
					{
						feature_id: "logs",
						enabled: true,
						threshold: 80,
						threshold_type: "usage_percentage",
						name: "Maple billing warning",
					},
				],
			},
		})
	})
})

describe("readCustomerCached", () => {
	it.effect("caches a 200 response: 2nd call hits the cache, upstream runs once", () =>
		Effect.gen(function* () {
			const cache = makeCache()
			let calls = 0
			const run = Effect.sync(() => {
				calls += 1
				return { statusCode: 200, response: { customer: ORG, calls } }
			})

			const first = yield* readCustomerCached(cache, ORG, run)
			const second = yield* readCustomerCached(cache, ORG, run)

			assert.strictEqual(calls, 1)
			assert.isFalse(first.hit)
			assert.isTrue(second.hit)
			assert.deepStrictEqual(second.result.response, { customer: ORG, calls: 1 })
		}),
	)

	it.effect("does NOT cache a non-200 response — recomputes on every call", () =>
		Effect.gen(function* () {
			const cache = makeCache()
			let calls = 0
			const run = Effect.sync(() => {
				calls += 1
				return { statusCode: 500, response: { error: "boom" } }
			})

			const first = yield* readCustomerCached(cache, ORG, run)
			const second = yield* readCustomerCached(cache, ORG, run)

			assert.strictEqual(calls, 2)
			assert.isFalse(first.hit)
			assert.isFalse(second.hit)
			assert.strictEqual(first.result.statusCode, 500)
		}),
	)

	it.effect("recomputes after the org entry is invalidated", () =>
		Effect.gen(function* () {
			const cache = makeCache()
			let calls = 0
			const run = Effect.sync(() => {
				calls += 1
				return { statusCode: 200, response: { calls } }
			})

			yield* readCustomerCached(cache, ORG, run)
			yield* readCustomerCached(cache, ORG, run) // served from cache
			yield* cache.invalidate({ bucket: CUSTOMER_CACHE_BUCKET, key: ORG })
			const after = yield* readCustomerCached(cache, ORG, run)

			assert.strictEqual(calls, 2)
			assert.isFalse(after.hit)
			assert.deepStrictEqual(after.result.response, { calls: 2 })
		}),
	)

	it.effect("scopes the cache per org — a different orgId is a separate entry", () =>
		Effect.gen(function* () {
			const cache = makeCache()
			let calls = 0
			const run = Effect.sync(() => {
				calls += 1
				return { statusCode: 200, response: { calls } }
			})

			yield* readCustomerCached(cache, "org_a", run)
			yield* readCustomerCached(cache, "org_b", run)

			assert.strictEqual(calls, 2)
		}),
	)

	it.effect("caches an active-plan customer for the full TTL", () =>
		Effect.gen(function* () {
			const { cache, puts } = makeRecordingBackend()
			const run = Effect.succeed({ statusCode: 200, response: activePlanResponse })
			yield* readCustomerCached(cache, ORG, run)
			assert.deepStrictEqual(puts, [CUSTOMER_CACHE_TTL_SECONDS])
		}),
	)

	it.effect("caches a never-subscribed customer for the short TTL — checkout is imminent", () =>
		Effect.gen(function* () {
			const { cache, puts } = makeRecordingBackend()
			const run = Effect.succeed({ statusCode: 200, response: noPlanResponse })
			yield* readCustomerCached(cache, ORG, run)
			assert.deepStrictEqual(puts, [CUSTOMER_CACHE_UNSETTLED_TTL_SECONDS])
		}),
	)

	it.effect("caches a lapsed customer for the middle TTL — durably planless, not mid-signup", () =>
		Effect.gen(function* () {
			const { cache, puts } = makeRecordingBackend()
			const run = Effect.succeed({ statusCode: 200, response: lapsedPlanResponse })
			yield* readCustomerCached(cache, ORG, run)
			assert.deepStrictEqual(puts, [CUSTOMER_CACHE_LAPSED_TTL_SECONDS])
		}),
	)

	it.effect("treats an error-shaped 200 (no subscriptions array) as unsettled → short TTL", () =>
		Effect.gen(function* () {
			const { cache, puts } = makeRecordingBackend()
			const run = Effect.succeed({ statusCode: 200, response: { error: "autumn_api_error" } })
			yield* readCustomerCached(cache, ORG, run)
			assert.deepStrictEqual(puts, [CUSTOMER_CACHE_UNSETTLED_TTL_SECONDS])
		}),
	)
})

describe("decodeInvoices", () => {
	it.effect("decodes the invoices array off an expanded customer response", () =>
		Effect.gen(function* () {
			const decoded = yield* decodeInvoices({
				id: ORG,
				subscriptions: [],
				invoices: [
					{
						stripeId: "in_123",
						planIds: ["startup"],
						processorType: "stripe",
						status: "paid",
						total: 42.3,
						currency: "usd",
						createdAt: 1_750_000_000_000,
						hostedInvoiceUrl: "https://invoice.stripe.com/i/in_123",
					},
					// Draft invoice: no hosted URL yet; unknown status must not fail decoding.
					{
						stripeId: "in_456",
						planIds: [],
						status: "some_future_status",
						total: 0,
						currency: "usd",
						createdAt: 1_751_000_000_000,
						hostedInvoiceUrl: null,
					},
				],
			})
			assert.strictEqual(decoded.invoices.length, 2)
			assert.strictEqual(decoded.invoices[0]?.stripeId, "in_123")
			assert.strictEqual(decoded.invoices[0]?.total, 42.3)
			assert.strictEqual(decoded.invoices[1]?.status, "some_future_status")
			assert.isNull(decoded.invoices[1]?.hostedInvoiceUrl)
		}),
	)

	it.effect("decodes an absent/null invoices key as an empty list", () =>
		Effect.gen(function* () {
			const missing = yield* decodeInvoices({ id: ORG, subscriptions: [] })
			assert.deepStrictEqual([...missing.invoices], [])
			const nulled = yield* decodeInvoices({ id: ORG, invoices: null })
			assert.deepStrictEqual([...nulled.invoices], [])
		}),
	)

	it.effect("fails with BillingUpstreamError on a malformed invoice entry", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(decodeInvoices({ invoices: [{ status: "paid" }] }))
			assert.isTrue(exit._tag === "Failure")
		}),
	)
})

describe("resolveCycleWindow", () => {
	const asCustomer = (subscriptions: ReadonlyArray<Record<string, unknown>>) =>
		Schema.decodeUnknownSync(BillingCustomer)({ id: ORG, subscriptions })

	const NOW = Date.UTC(2026, 6, 29, 12) // Jul 29, 2026

	it("uses the active subscription's period, not the calendar month", () => {
		// An org that subscribed on the 12th is billed on its own anniversary; a
		// calendar-month chart would disagree with the invoice.
		const window = resolveCycleWindow(
			asCustomer([
				{
					planId: "startup",
					status: "active",
					currentPeriodStart: Date.UTC(2026, 6, 12),
					currentPeriodEnd: Date.UTC(2026, 7, 12),
				},
			]),
			NOW,
		)

		assert.strictEqual(window.startMs, Date.UTC(2026, 6, 12))
		// The full period, NOT clamped to now: the chart has to reach the day the
		// bill closes to show where the cycle is headed. `nowMs` rides along so the
		// warehouse read can clamp itself.
		assert.strictEqual(window.endMs, Date.UTC(2026, 7, 12))
		assert.strictEqual(window.nowMs, NOW)
	})

	it("falls back to the calendar month with no active subscription — there is still usage to show", () => {
		const window = resolveCycleWindow(asCustomer([]), NOW)

		assert.strictEqual(window.startMs, Date.UTC(2026, 6, 1))
		// Through the end of July, so a planless org still gets a full axis.
		assert.strictEqual(window.endMs, Date.UTC(2026, 7, 1) - 1)
	})
})

describe("responseHasActivePlan", () => {
	it("is true for an active (trialing) base-plan subscription", () => {
		assert.isTrue(responseHasActivePlan(activePlanResponse))
	})

	it("is false with no subscriptions, an empty list, or a non-active status", () => {
		assert.isFalse(responseHasActivePlan(noPlanResponse))
		assert.isFalse(responseHasActivePlan({ id: ORG }))
		assert.isFalse(responseHasActivePlan({ subscriptions: [{ planId: "startup", status: "expired" }] }))
	})
})

describe("responseHasPlanHistory", () => {
	it("separates a lapsed customer from one that never subscribed", () => {
		assert.isTrue(responseHasPlanHistory(lapsedPlanResponse))
		assert.isTrue(responseHasPlanHistory(activePlanResponse))
		assert.isFalse(responseHasPlanHistory(noPlanResponse))
		assert.isFalse(responseHasPlanHistory({ id: ORG }))
	})

	it("ignores add-on, auto-enabled and free rows — they never gated anything", () => {
		assert.isFalse(
			responseHasPlanHistory({ subscriptions: [{ planId: "byoc", status: "expired", addOn: true }] }),
		)
		assert.isFalse(responseHasPlanHistory({ subscriptions: [{ planId: "free", status: "expired" }] }))
	})
})

describe("summariseSubscriptions", () => {
	it("describes every row Autumn returned, aligned by position", () => {
		// The whole point is diagnosing a wrongly-gated org from telemetry alone,
		// so an excluded row must still appear in the lists — knowing the row was
		// there and was discarded is the answer we go looking for.
		assert.deepStrictEqual(
			summariseSubscriptions({
				subscriptions: [
					{ planId: "startup", status: "expired" },
					{ planId: "byoc", status: "active", addOn: true },
					{ planId: "free", status: "active", autoEnable: true },
				],
			}),
			{
				"billing.subscription_count": 3,
				"billing.subscription_statuses": "expired,active,active",
				"billing.subscription_plan_ids": "startup,byoc,free",
				"billing.subscription_excluded": "-,addon,auto",
				"billing.has_active_plan": false,
				"billing.has_plan_history": true,
			},
		)
	})

	it("reports a never-subscribed customer as empty rather than throwing", () => {
		assert.deepStrictEqual(summariseSubscriptions(noPlanResponse), {
			"billing.subscription_count": 0,
			"billing.subscription_statuses": "",
			"billing.subscription_plan_ids": "",
			"billing.subscription_excluded": "",
			"billing.has_active_plan": false,
			"billing.has_plan_history": false,
		})
	})

	it("survives an error-shaped payload with no subscriptions array", () => {
		// `getCustomer` annotates BEFORE `ensureOk`, so it sees Autumn's error
		// bodies too — the summary must never be the thing that fails the request.
		const summary = summariseSubscriptions({ code: "autumn_api_error", message: "boom" })
		assert.strictEqual(summary["billing.subscription_count"], 0)
		assert.strictEqual(summary["billing.has_plan_history"], false)
	})

	it("marks a row missing planId or status without shifting the columns", () => {
		assert.deepStrictEqual(
			summariseSubscriptions({ subscriptions: [{ status: "expired" }, { planId: "pro" }] }),
			{
				"billing.subscription_count": 2,
				"billing.subscription_statuses": "expired,-",
				"billing.subscription_plan_ids": "-,pro",
				"billing.subscription_excluded": "-,-",
				"billing.has_active_plan": false,
				"billing.has_plan_history": true,
			},
		)
	})
})

describe("resolveAttachConflict", () => {
	const conflict = new BillingConflictError({
		message: "Customer already has this plan",
		code: "already_attached",
		upstreamStatus: 409,
	})

	const customerRead = (response: unknown, statusCode = 200) =>
		Effect.succeed({ statusCode, response } satisfies AutumnResult)

	it("answers success when the customer already holds the plan", async () => {
		// The double-click case that produced 5 of our 9 attach 502s: the first
		// attach succeeded, the page sat on the old DOM while the browser navigated
		// to Stripe, and the customer clicked again. Telling someone who has just
		// paid that their purchase failed is the worst outcome available here.
		const result = await Effect.runPromise(
			resolveAttachConflict(customerRead(activePlanResponse), "startup", conflict),
		)
		assert.deepStrictEqual(result, {})
	})

	it("re-fails when the conflict was about something else", async () => {
		// 409 is not exclusively "already attached", so a conflict we cannot
		// explain must keep its status rather than be swallowed as success.
		const error = await Effect.runPromise(
			Effect.flip(resolveAttachConflict(customerRead(noPlanResponse), "startup", conflict)),
		)
		assert.strictEqual(error._tag, "@maple/http/errors/BillingConflictError")
	})

	it("re-fails when the customer holds a DIFFERENT plan", async () => {
		const error = await Effect.runPromise(
			Effect.flip(resolveAttachConflict(customerRead(activePlanResponse), "enterprise", conflict)),
		)
		assert.strictEqual(error._tag, "@maple/http/errors/BillingConflictError")
	})

	it("re-fails when the confirming read itself fails", async () => {
		// No confirmation means no licence to call it a success.
		const error = await Effect.runPromise(
			Effect.flip(resolveAttachConflict(customerRead({ message: "boom" }, 503), "startup", conflict)),
		)
		assert.strictEqual(error._tag, "@maple/http/errors/BillingConflictError")
	})

	it("counts a trialing subscription Autumn reports as active", async () => {
		// Autumn reports trials as `active`; a trialist re-clicking Subscribe is
		// the exact population this incident came from.
		const trialing = {
			id: ORG,
			subscriptions: [{ planId: "startup", status: "active", trialEndsAt: 9_999_999_999_000 }],
		}
		const result = await Effect.runPromise(
			resolveAttachConflict(customerRead(trialing), "startup", conflict),
		)
		assert.deepStrictEqual(result, {})
	})
})

// Changing the subscription and opening the Stripe portal are org-wide spend
// decisions, gated like every other billing write in the group.
describe("billing writes over HTTP", () => {
	class BillingOnlyApi extends HttpApi.make("MapleInternalApi")
		.add(BillingApiGroup)
		.middleware(V1SchemaErrors)
		.middleware(V1UnexpectedErrors) {}

	const decodeTenant = Schema.decodeUnknownSync(CurrentTenant.TenantSchema)
	const tenantWithRoles = (roles: ReadonlyArray<string>) =>
		decodeTenant({ orgId: ORG, userId: "user_billing_test", roles, authMode: "self_hosted" })

	const die = () => Effect.die(new Error("not reachable once the admin gate rejects"))

	const makeHarness = (roles: ReadonlyArray<string>) => {
		const routes = HttpApiBuilder.layer(BillingOnlyApi).pipe(
			Layer.provide(HttpBillingLive),
			Layer.provide(V1ErrorBoundaryLive),
			Layer.provideMerge(
				Layer.succeed(
					CurrentTenant.SessionAuthorization,
					CurrentTenant.SessionAuthorization.of({
						bearer: (httpEffect) =>
							Effect.provideService(httpEffect, CurrentTenant.Context, tenantWithRoles(roles)),
					}),
				),
			),
			Layer.provideMerge(Layer.succeed(EdgeCacheService, makeCache())),
			Layer.provideMerge(Layer.succeed(DailySpendService, { get: die })),
			Layer.provideMerge(Layer.succeed(ProductEventsService, { track: die, trackMany: die })),
			Layer.provideMerge(Layer.succeed(StripeClient, { request: die })),
			Layer.provideMerge(
				Layer.succeed(AutumnClient, {
					attach: die,
					openCustomerPortal: die,
				} as never),
			),
		)
		const { handler, dispose } = HttpRouter.toWebHandler(routes as never, { disableLogger: true })

		const post = async (path: string, body: unknown) => {
			const response = await handler(
				new Request(`http://maple.test${path}`, {
					method: "POST",
					headers: { authorization: "Bearer test-token", "content-type": "application/json" },
					body: JSON.stringify(body),
				}),
				Context.empty() as never,
			)
			const text = await response.text()
			return { status: response.status, body: text.length === 0 ? null : JSON.parse(text) }
		}

		return { post, dispose }
	}

	it("refuses attach from a non-admin member", async () => {
		const harness = makeHarness(["org:member"])
		try {
			const response = await harness.post("/internal/billing/attach", { planId: "startup" })
			assert.strictEqual(response.status, 403)
			assert.strictEqual(response.body._tag, "@maple/http/errors/BillingForbiddenError")
		} finally {
			await harness.dispose()
		}
	})

	it("refuses the Stripe customer portal from a non-admin member", async () => {
		const harness = makeHarness(["org:member"])
		try {
			const response = await harness.post("/internal/billing/portal", {
				returnUrl: "https://maple.test/settings/billing",
			})
			assert.strictEqual(response.status, 403)
			assert.strictEqual(response.body._tag, "@maple/http/errors/BillingForbiddenError")
		} finally {
			await harness.dispose()
		}
	})
})

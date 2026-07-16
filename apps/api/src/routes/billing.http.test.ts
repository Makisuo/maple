import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { type EdgeCacheBackend, makeEdgeCacheService, makeMemoryBackend } from "@maple/query-engine/caching"
import {
	CUSTOMER_CACHE_BUCKET,
	CUSTOMER_CACHE_TTL_SECONDS,
	CUSTOMER_CACHE_UNSETTLED_TTL_SECONDS,
	decodeInvoices,
	readCustomerCached,
	responseHasActivePlan,
} from "./billing.http"

const ORG = "org_test_123"

const makeCache = () => makeEdgeCacheService(makeMemoryBackend())

// Wrap the real memory backend so caching/expiry still works, but record the
// TTL handed to each `put` — lets us assert the content-dependent TTL policy.
const makeRecordingBackend = () => {
	const inner = makeMemoryBackend()
	const puts: number[] = []
	const backend: EdgeCacheBackend = {
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

	it.effect("caches a planless customer for the short TTL so the gate re-checks soon", () =>
		Effect.gen(function* () {
			const { cache, puts } = makeRecordingBackend()
			const run = Effect.succeed({ statusCode: 200, response: noPlanResponse })
			yield* readCustomerCached(cache, ORG, run)
			assert.deepStrictEqual(puts, [CUSTOMER_CACHE_UNSETTLED_TTL_SECONDS])
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

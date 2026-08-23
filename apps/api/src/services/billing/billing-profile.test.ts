import { assert, describe, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { makeEdgeCacheService, makeMemoryBackend } from "@maple/cache"
import type { AutumnResult } from "@/services/billing/autumn-http"
import { CUSTOMER_CACHE_BUCKET } from "@/services/billing/autumn-client"
import {
	ensureStripeCustomerId,
	isAlreadyRemoved,
	readBillingProfile,
	readStripeCustomerId,
	stripeCustomerIdOf,
} from "@/services/billing/billing-profile"

const ORG = "org_test_123"
const CUS = "cus_test_123"

const makeCache = () => makeEdgeCacheService(makeMemoryBackend())

const ok = (response: unknown): AutumnResult => ({ statusCode: 200, response })

/**
 * An Autumn stub that answers `getOrCreateCustomer` from a script and records
 * whether each call asked for `create_in_stripe`.
 */
const autumnStub = (responses: ReadonlyArray<unknown>) => {
	const calls: Array<{ readonly createInStripe: boolean | undefined }> = []
	let index = 0
	return {
		calls,
		getOrCreateCustomer: (_orgId: string, options: { readonly createInStripe?: boolean | undefined }) =>
			Effect.sync(() => {
				calls.push({ createInStripe: options.createInStripe })
				const response = responses[Math.min(index, responses.length - 1)]
				index += 1
				return ok(response)
			}),
	}
}

describe("stripeCustomerIdOf", () => {
	it("reads the camelised stripeId off a raw customer", () => {
		assert.deepStrictEqual(stripeCustomerIdOf({ id: ORG, stripeId: CUS }), Option.some(CUS))
	})

	it("is None for a missing, null or empty id and for a non-object", () => {
		assert.isTrue(Option.isNone(stripeCustomerIdOf({ id: ORG })))
		assert.isTrue(Option.isNone(stripeCustomerIdOf({ id: ORG, stripeId: null })))
		assert.isTrue(Option.isNone(stripeCustomerIdOf({ id: ORG, stripeId: "" })))
		assert.isTrue(Option.isNone(stripeCustomerIdOf(null)))
		assert.isTrue(Option.isNone(stripeCustomerIdOf("cus_x")))
	})
})

describe("readStripeCustomerId", () => {
	it.effect("never asks Autumn to create the Stripe customer", () =>
		Effect.gen(function* () {
			const autumn = autumnStub([{ id: ORG, stripeId: null }])
			const linked = yield* readStripeCustomerId(makeCache(), autumn, ORG)
			assert.isTrue(Option.isNone(linked))
			assert.deepStrictEqual(autumn.calls, [{ createInStripe: undefined }])
		}),
	)

	it.effect("serves the id from the shared customer cache on a second read", () =>
		Effect.gen(function* () {
			const cache = makeCache()
			const autumn = autumnStub([{ id: ORG, stripeId: CUS }])
			yield* readStripeCustomerId(cache, autumn, ORG)
			const again = yield* readStripeCustomerId(cache, autumn, ORG)
			assert.deepStrictEqual(again, Option.some(CUS))
			assert.strictEqual(autumn.calls.length, 1)
		}),
	)
})

describe("ensureStripeCustomerId", () => {
	it.effect("returns the linked id without a create when Autumn already has one", () =>
		Effect.gen(function* () {
			const autumn = autumnStub([{ id: ORG, stripeId: CUS }])
			const id = yield* ensureStripeCustomerId(makeCache(), autumn, ORG)
			assert.strictEqual(id, CUS)
			assert.deepStrictEqual(autumn.calls, [{ createInStripe: undefined }])
		}),
	)

	it.effect("asks Autumn for create_in_stripe when unlinked, then drops the stale cache entry", () =>
		Effect.gen(function* () {
			const cache = makeCache()
			const autumn = autumnStub([
				{ id: ORG, stripeId: null },
				{ id: ORG, stripeId: CUS },
			])
			const id = yield* ensureStripeCustomerId(cache, autumn, ORG)
			assert.strictEqual(id, CUS)
			assert.deepStrictEqual(autumn.calls, [{ createInStripe: undefined }, { createInStripe: true }])

			// The unlinked snapshot must not outlive the create: the next read goes
			// upstream again (and sees the linked customer).
			const after = yield* readStripeCustomerId(cache, autumn, ORG)
			assert.deepStrictEqual(after, Option.some(CUS))
			assert.strictEqual(autumn.calls.length, 3)
		}),
	)

	it.effect("fails as unavailable when Autumn still reports no link after the create", () =>
		Effect.gen(function* () {
			const autumn = autumnStub([{ id: ORG, stripeId: null }])
			const error = yield* Effect.flip(ensureStripeCustomerId(makeCache(), autumn, ORG))
			assert.strictEqual(error._tag, "@maple/http/errors/BillingProfileUnavailableError")
		}),
	)

	it.effect("does not leave a stale unlinked entry behind when the create fails", () =>
		Effect.gen(function* () {
			const cache = makeCache()
			const autumn = autumnStub([{ id: ORG, stripeId: null }])
			yield* Effect.flip(ensureStripeCustomerId(cache, autumn, ORG))
			const cached = yield* cache.getOrCompute(
				{ bucket: CUSTOMER_CACHE_BUCKET, key: ORG, ttlSeconds: 60 },
				Effect.succeed("recomputed"),
			)
			assert.strictEqual(cached.value, "recomputed")
		}),
	)
})

describe("readBillingProfile", () => {
	const stripeStub = (customer: unknown, taxIds: unknown) => ({
		getCustomer: () => Effect.succeed(ok(customer)),
		listTaxIds: () => Effect.succeed(ok(taxIds)),
	})

	it.effect("maps the Stripe customer + tax IDs into a linked profile", () =>
		Effect.gen(function* () {
			const profile = yield* readBillingProfile(
				stripeStub(
					{
						id: CUS,
						name: "Acme GmbH",
						address: { line1: "Hauptstr. 1", city: "Berlin", postalCode: "10115", country: "DE" },
					},
					{
						object: "list",
						data: [
							{
								id: "txi_1",
								type: "eu_vat",
								value: "DE123456789",
								country: "DE",
								verification: { status: "verified", verifiedName: "ACME GMBH" },
							},
						],
					},
				),
				CUS,
			)
			assert.isTrue(profile.linked)
			assert.strictEqual(profile.name, "Acme GmbH")
			assert.strictEqual(profile.address?.city, "Berlin")
			assert.strictEqual(profile.address?.postalCode, "10115")
			assert.deepStrictEqual(
				profile.taxIds.map((t) => ({ ...t })),
				[
					{
						id: "txi_1",
						type: "eu_vat",
						value: "DE123456789",
						country: "DE",
						verificationStatus: "verified",
					},
				],
			)
		}),
	)

	it.effect("tolerates a bare customer with no name, address or verification", () =>
		Effect.gen(function* () {
			const profile = yield* readBillingProfile(
				stripeStub(
					{ id: CUS },
					{ object: "list", data: [{ id: "txi_2", type: "us_ein", value: "12-3456789" }] },
				),
				CUS,
			)
			assert.strictEqual(profile.name, null)
			assert.strictEqual(profile.address, null)
			assert.strictEqual(profile.taxIds[0]?.verificationStatus, null)
		}),
	)

	it.effect("collapses a Stripe rejection on the read into a 502", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(
				readBillingProfile(
					{
						getCustomer: () =>
							Effect.succeed({
								statusCode: 404,
								response: {
									message: "No such customer",
									code: "resource_missing",
									statusCode: 404,
								},
							}),
						listTaxIds: () => Effect.succeed(ok({ data: [] })),
					},
					CUS,
				),
			)
			assert.strictEqual(error._tag, "@maple/http/errors/BillingUpstreamError")
		}),
	)
})

describe("isAlreadyRemoved", () => {
	it("is true only for Stripe's 404 resource_missing", () => {
		assert.isTrue(
			isAlreadyRemoved({ statusCode: 404, response: { code: "resource_missing", statusCode: 404 } }),
		)
		assert.isFalse(isAlreadyRemoved({ statusCode: 404, response: { code: "other", statusCode: 404 } }))
		assert.isFalse(
			isAlreadyRemoved({ statusCode: 400, response: { code: "resource_missing", statusCode: 400 } }),
		)
		assert.isFalse(isAlreadyRemoved({ statusCode: 200, response: { deleted: true } }))
	})
})

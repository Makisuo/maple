import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Env } from "@/platform/Env"
import { classifyAutumn, ensureOk } from "@/services/billing/autumn-client"
import type { AutumnResult } from "@/services/billing/autumn-http"
import { STRIPE_API_VERSION } from "@/services/billing/stripe-api"
import { StripeClient, type StripeClientApi, encodeForm } from "@/services/billing/stripe-http"

const CUS = "cus_test_123"
const KEY = "rk_test_abc"
const API_URL = "https://api.stripe.com"

interface Captured {
	readonly url: string
	readonly method: string
	readonly headers: Headers
	readonly body: string
}

/** Everything `Env` needs to build, plus the Stripe keys under test. */
const testEnv = (stripe: Record<string, string>) =>
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
					...stripe,
				}),
			),
		),
	)

const clientLayer = (stripe: Record<string, string> = { STRIPE_SECRET_KEY: KEY, STRIPE_API_URL: API_URL }) =>
	StripeClient.layer.pipe(Layer.provide(testEnv(stripe)))

// Same seam as autumn-http.test.ts: provide the `Fetch` reference per run
// rather than swapping `globalThis.fetch`, whose default is memoized.
const provideFetch = <A, E>(effect: Effect.Effect<A, E>, fetch: typeof globalThis.fetch) =>
	Effect.provideService(effect, FetchHttpClient.Fetch, fetch)

const runWithClient = <A, E>(
	fetch: typeof globalThis.fetch,
	run: (client: StripeClientApi) => Effect.Effect<A, E>,
	layer = clientLayer(),
) =>
	Effect.gen(function* () {
		const stripe = yield* StripeClient
		return yield* provideFetch(run(stripe), fetch)
	}).pipe(Effect.provide(layer))

const withFetch = async (
	respond: { readonly status?: number; readonly body?: string },
	run: (client: StripeClientApi) => Effect.Effect<AutumnResult, unknown>,
): Promise<{ readonly captured: Captured | undefined; readonly result: AutumnResult }> => {
	let captured: Captured | undefined
	const fetch = (async (input, init) => {
		const text =
			init?.body === undefined || init.body === null ? "" : await new Response(init.body).text()
		captured = {
			url: String(input),
			method: String(init?.method),
			headers: new Headers(init?.headers),
			body: text,
		}
		return new Response(respond.body ?? JSON.stringify({ object: "customer" }), {
			status: respond.status ?? 200,
		})
	}) as typeof globalThis.fetch

	const result = await Effect.runPromise(runWithClient(fetch, run))
	assert.strictEqual(captured?.headers.get("authorization"), `Bearer ${KEY}`)
	assert.strictEqual(captured?.headers.get("stripe-version"), STRIPE_API_VERSION)
	return { captured, result }
}

describe("encodeForm", () => {
	it("flattens nested objects into Stripe's bracket keys and drops undefined", () => {
		assert.deepStrictEqual(
			encodeForm({
				name: "Acme GmbH",
				address: { line1: "Hauptstr. 1", line2: undefined, country: "DE" },
				skipped: undefined,
			}),
			[
				["name", "Acme GmbH"],
				["address[line1]", "Hauptstr. 1"],
				["address[country]", "DE"],
			],
		)
	})

	it("sends null as the empty string, which is how Stripe unsets a field", () => {
		assert.deepStrictEqual(encodeForm({ name: null, address: null }), [
			["name", ""],
			["address", ""],
		])
	})
})

describe("StripeClient request construction", () => {
	it("getCustomer GETs the customer", async () => {
		const { captured } = await withFetch({}, (stripe) => stripe.getCustomer(CUS))
		assert.strictEqual(captured?.url, `${API_URL}/v1/customers/${CUS}`)
		assert.strictEqual(captured?.method, "GET")
	})

	it("updateCustomer POSTs form-encoded name + nested address", async () => {
		const { captured } = await withFetch({}, (stripe) =>
			stripe.updateCustomer(CUS, {
				name: "Acme GmbH",
				address: { line1: "Hauptstr. 1", city: "Berlin", postalCode: "10115", country: "DE" },
			}),
		)
		assert.strictEqual(captured?.url, `${API_URL}/v1/customers/${CUS}`)
		assert.strictEqual(captured?.method, "POST")
		assert.match(captured?.headers.get("content-type") ?? "", /application\/x-www-form-urlencoded/)
		const params = new URLSearchParams(captured?.body)
		assert.strictEqual(params.get("name"), "Acme GmbH")
		assert.strictEqual(params.get("address[line1]"), "Hauptstr. 1")
		assert.strictEqual(params.get("address[city]"), "Berlin")
		assert.strictEqual(params.get("address[postal_code]"), "10115")
		assert.strictEqual(params.get("address[country]"), "DE")
		// Omitted lines stay omitted: Stripe leaves them as they are.
		assert.isFalse(params.has("address[line2]"))
		assert.isFalse(params.has("address[state]"))
	})

	it("updateCustomer clears the address with an empty string when given null", async () => {
		const { captured } = await withFetch({}, (stripe) => stripe.updateCustomer(CUS, { address: null }))
		const params = new URLSearchParams(captured?.body)
		assert.strictEqual(params.get("address"), "")
		assert.isFalse(params.has("name"))
	})

	it("listTaxIds GETs the customer's tax_ids with the page maximum", async () => {
		const { captured } = await withFetch(
			{ body: JSON.stringify({ object: "list", data: [] }) },
			(stripe) => stripe.listTaxIds(CUS),
		)
		assert.strictEqual(captured?.url, `${API_URL}/v1/customers/${CUS}/tax_ids?limit=100`)
		assert.strictEqual(captured?.method, "GET")
	})

	it("createTaxId POSTs type + value form-encoded", async () => {
		const { captured } = await withFetch({}, (stripe) =>
			stripe.createTaxId(CUS, { type: "eu_vat", value: "DE123456789" }),
		)
		assert.strictEqual(captured?.url, `${API_URL}/v1/customers/${CUS}/tax_ids`)
		assert.strictEqual(captured?.method, "POST")
		assert.strictEqual(captured?.body, "type=eu_vat&value=DE123456789")
	})

	it("deleteTaxId DELETEs the tax id", async () => {
		const { captured } = await withFetch({ body: JSON.stringify({ deleted: true }) }, (stripe) =>
			stripe.deleteTaxId(CUS, "txi_1"),
		)
		assert.strictEqual(captured?.url, `${API_URL}/v1/customers/${CUS}/tax_ids/txi_1`)
		assert.strictEqual(captured?.method, "DELETE")
	})
})

describe("StripeClient responses", () => {
	it("camelises a 2xx body so the Autumn decoders apply", async () => {
		const { result } = await withFetch(
			{
				body: JSON.stringify({
					object: "list",
					data: [
						{
							id: "txi_1",
							type: "eu_vat",
							value: "DE123456789",
							country: "DE",
							verification: { status: "pending", verified_name: null },
						},
					],
				}),
			},
			(stripe) => stripe.listTaxIds(CUS),
		)
		assert.strictEqual(result.statusCode, 200)
		assert.deepStrictEqual(result.response, {
			object: "list",
			data: [
				{
					id: "txi_1",
					type: "eu_vat",
					value: "DE123456789",
					country: "DE",
					verification: { status: "pending", verifiedName: null },
				},
			],
		})
	})

	it("flattens Stripe's nested error into the Autumn-shaped rejection body", async () => {
		const { result } = await withFetch(
			{
				status: 400,
				body: JSON.stringify({
					error: {
						type: "invalid_request_error",
						code: "tax_id_invalid",
						message: "Invalid value for eu_vat: DE1",
						param: "value",
					},
				}),
			},
			(stripe) => stripe.createTaxId(CUS, { type: "eu_vat", value: "DE1" }),
		)
		assert.strictEqual(result.statusCode, 400)
		assert.deepStrictEqual(result.response, {
			message: "Invalid value for eu_vat: DE1",
			code: "tax_id_invalid",
			statusCode: 400,
		})

		// …which `classifyAutumn` then turns into the public 400 with Stripe's
		// wording — the only place the format expectation is spelled out.
		const error = await Effect.runPromise(Effect.flip(classifyAutumn(result)))
		assert.strictEqual(error._tag, "@maple/http/errors/BillingRequestError")
		assert.strictEqual(error.message, "Invalid value for eu_vat: DE1")
	})

	it("falls back to the error type when Stripe sends no code", async () => {
		const { result } = await withFetch(
			{
				status: 404,
				body: JSON.stringify({
					error: { type: "invalid_request_error", message: "No such customer: cus_x" },
				}),
			},
			(stripe) => stripe.getCustomer(CUS),
		)
		assert.deepStrictEqual(result.response, {
			message: "No such customer: cus_x",
			code: "invalid_request_error",
			statusCode: 404,
		})
		// A pure read collapses to 502 — a 4xx on GET is OUR bug, not the caller's.
		const error = await Effect.runPromise(Effect.flip(ensureOk(result)))
		assert.strictEqual(error._tag, "@maple/http/errors/BillingUpstreamError")
	})

	it("treats an empty 2xx body as an upstream failure", async () => {
		const fetch = (async () => new Response("", { status: 200 })) as typeof globalThis.fetch
		const error = await Effect.runPromise(
			Effect.flip(runWithClient(fetch, (stripe) => stripe.getCustomer(CUS))),
		)
		assert.strictEqual(error._tag, "@maple/http/errors/BillingUpstreamError")
	})

	it("fails as not-configured without a key, before any request is made", async () => {
		let called = false
		const fetch = (async () => {
			called = true
			return new Response("{}", { status: 200 })
		}) as typeof globalThis.fetch
		const error = await Effect.runPromise(
			Effect.flip(runWithClient(fetch, (stripe) => stripe.getCustomer(CUS), clientLayer({}))),
		)
		assert.strictEqual(error._tag, "@maple/http/errors/BillingNotConfiguredError")
		assert.isFalse(called)
	})
})

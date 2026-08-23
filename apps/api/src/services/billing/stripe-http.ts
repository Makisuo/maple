// BOUNDARY: This module intentionally carries opaque values; callers decode them before domain use.
import { Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { BillingNotConfiguredError, BillingUpstreamError } from "@maple/domain/http"
import { Env } from "@/platform/Env"
import type { AutumnResult, AutumnTransportFailure } from "./autumn-http"
import { camelizeKeys } from "./autumn-http"
import { STRIPE_API_VERSION } from "./stripe-api"

/**
 * The slice of Stripe's REST surface the billing-details card needs, spoken
 * directly.
 *
 * Autumn owns the subscription; the Stripe customer it links is where the
 * invoice's company name, address and tax IDs live, and Autumn's API has no
 * field for any of them (its "Stripe Sync" guide files cosmetic customer
 * updates under "do this in Stripe"). No `stripe` npm package: the five calls
 * below are ~100 lines of `HttpClient`, versus a dependency whose module graph
 * would land in the worker for every request.
 *
 * Results are shaped exactly like `AutumnResult` — `{ statusCode, response }`
 * with a camelised 2xx body, or an Autumn-shaped `{ message, code, statusCode }`
 * rejection body — so `classifyAutumn` / `ensureOk` / `decodeUpstream` in
 * `autumn-client.ts` apply unchanged. Stripe nests its error as
 * `{ error: { type, code, message, param } }`; `errorResponse` flattens it.
 */

export interface StripeAddressInput {
	readonly line1?: string | null
	readonly line2?: string | null
	readonly city?: string | null
	readonly state?: string | null
	readonly postalCode?: string | null
	readonly country?: string | null
}

export interface StripeCustomerUpdate {
	readonly name?: string | null
	readonly address?: StripeAddressInput | null
}

type StripeRoute = "getCustomer" | "updateCustomer" | "listTaxIds" | "createTaxId" | "deleteTaxId"

type StripeCall = Effect.Effect<AutumnResult, AutumnTransportFailure>

export interface StripeClientApi {
	readonly getCustomer: (stripeCustomerId: string) => StripeCall
	readonly updateCustomer: (stripeCustomerId: string, update: StripeCustomerUpdate) => StripeCall
	readonly listTaxIds: (stripeCustomerId: string) => StripeCall
	readonly createTaxId: (
		stripeCustomerId: string,
		taxId: { readonly type: string; readonly value: string },
	) => StripeCall
	readonly deleteTaxId: (stripeCustomerId: string, taxIdId: string) => StripeCall
}

const toBillingUpstreamError = (error: unknown) =>
	new BillingUpstreamError({
		message: error instanceof Error ? error.message : String(error),
	})

const JsonBody = Schema.fromJsonString(Schema.Unknown)
const decodeJson = Schema.decodeEffect(JsonBody)
const parseJsonOption = Schema.decodeUnknownOption(JsonBody)

const trimTrailingSlash = (url: string) => url.replace(/\/+$/, "")

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined

/**
 * Flatten Stripe's nested error into the `{ message, code, statusCode }` body
 * `upstreamMessage` / `upstreamCode` (autumn-client.ts) already read. Stripe's
 * `code` (`tax_id_invalid`, `resource_missing`, …) is what the route and the
 * span want; `type` (`invalid_request_error`) is the coarser bucket, kept as
 * the fallback code so a code-less rejection still names its class.
 */
const errorResponse = (statusCode: number, text: string): Record<string, unknown> => {
	const parsed = asRecord(Option.getOrUndefined(parseJsonOption(text)))
	const error = asRecord(parsed?.error)
	const message = error?.message
	const code = error?.code ?? error?.type
	return {
		...(typeof message === "string" ? { message } : undefined),
		code: typeof code === "string" ? code : "stripe_api_error",
		statusCode,
	}
}

/** `address[line1]=…` style keys, as Stripe's form encoding wants nested objects. */
type FormValue = string | null | undefined | { readonly [key: string]: FormValue }

export const encodeForm = (fields: {
	readonly [key: string]: FormValue
}): ReadonlyArray<readonly [string, string]> => {
	const out: Array<readonly [string, string]> = []
	const walk = (prefix: string, value: FormValue) => {
		if (value === undefined) return
		// Stripe clears a field when it receives the empty string; `null` maps to
		// that so a caller can unset name/address lines without special-casing.
		if (value === null) {
			out.push([prefix, ""])
			return
		}
		if (typeof value === "string") {
			out.push([prefix, value])
			return
		}
		for (const [key, child] of Object.entries(value)) {
			walk(`${prefix}[${key}]`, child)
		}
	}
	for (const [key, value] of Object.entries(fields)) walk(key, value)
	return out
}

const callStripe = (
	client: HttpClient.HttpClient,
	secretKey: string | undefined,
	apiUrl: string,
	route: StripeRoute,
	request: HttpClientRequest.HttpClientRequest,
): StripeCall =>
	secretKey === undefined
		? // Same posture as Autumn: a missing key is OUR deployment fault, and the
			// layer still builds so an unconfigured worker boots.
			Effect.fail(new BillingNotConfiguredError({ message: "Billing details are not configured" }))
		: Effect.gen(function* () {
				const response = yield* client
					.execute(
						request.pipe(
							HttpClientRequest.prependUrl(apiUrl),
							HttpClientRequest.setHeaders({
								Authorization: `Bearer ${secretKey}`,
								"Stripe-Version": STRIPE_API_VERSION,
								Accept: "application/json",
							}),
						),
					)
					.pipe(Effect.mapError(toBillingUpstreamError))
				const text = yield* response.text.pipe(Effect.mapError(toBillingUpstreamError))
				yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status })

				if (response.status >= 200 && response.status < 300) {
					if (text.length === 0) {
						return yield* new BillingUpstreamError({
							message: `Stripe returned an empty body for ${route} (HTTP ${response.status})`,
						})
					}
					const json = yield* decodeJson(text).pipe(Effect.mapError(toBillingUpstreamError))
					return { statusCode: response.status, response: camelizeKeys(json) }
				}

				const errorBody = errorResponse(response.status, text)
				if (typeof errorBody.code === "string") {
					yield* Effect.annotateCurrentSpan({ "stripe.code": errorBody.code })
				}
				return { statusCode: response.status, response: errorBody }
			}).pipe(Effect.withSpan("stripe.request", { attributes: { "stripe.route": route } }))

const customerPath = (stripeCustomerId: string) => `/v1/customers/${encodeURIComponent(stripeCustomerId)}`

/**
 * Stripe's customer + tax-ID routes, bound to the worker's credentials and one
 * `HttpClient`. As with `AutumnClient`, every returned effect is `R = never`.
 */
export class StripeClient extends Context.Service<StripeClient, StripeClientApi>()(
	"@maple/api/services/billing/StripeClient",
	{
		make: Effect.gen(function* () {
			const env = yield* Env
			const httpClient = yield* HttpClient.HttpClient
			const secretKey = Option.match(env.STRIPE_SECRET_KEY, {
				onNone: () => undefined,
				onSome: (value) => Redacted.value(value),
			})
			const apiUrl = trimTrailingSlash(env.STRIPE_API_URL)

			const call = (route: StripeRoute, request: HttpClientRequest.HttpClientRequest) =>
				callStripe(httpClient, secretKey, apiUrl, route, request)

			return {
				getCustomer: (cus) => call("getCustomer", HttpClientRequest.get(customerPath(cus))),

				updateCustomer: (cus, update) =>
					call(
						"updateCustomer",
						HttpClientRequest.post(customerPath(cus)).pipe(
							HttpClientRequest.bodyUrlParams(
								encodeForm({
									name: update.name,
									address:
										update.address === undefined
											? undefined
											: update.address === null
												? // An empty string clears the whole address object.
													null
												: {
														line1: update.address.line1,
														line2: update.address.line2,
														city: update.address.city,
														state: update.address.state,
														postal_code: update.address.postalCode,
														country: update.address.country,
													},
								}),
							),
						),
					),

				// 100 is Stripe's page maximum; a customer has a handful at most.
				listTaxIds: (cus) =>
					call(
						"listTaxIds",
						HttpClientRequest.get(`${customerPath(cus)}/tax_ids`).pipe(
							HttpClientRequest.setUrlParam("limit", "100"),
						),
					),

				createTaxId: (cus, { type, value }) =>
					call(
						"createTaxId",
						HttpClientRequest.post(`${customerPath(cus)}/tax_ids`).pipe(
							HttpClientRequest.bodyUrlParams(encodeForm({ type, value })),
						),
					),

				deleteTaxId: (cus, taxIdId) =>
					call(
						"deleteTaxId",
						HttpClientRequest.delete(
							`${customerPath(cus)}/tax_ids/${encodeURIComponent(taxIdId)}`,
						),
					),
			} satisfies StripeClientApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(FetchHttpClient.layer))
}

// BOUNDARY: This module intentionally carries opaque values; callers decode them before domain use.
import { Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { BillingUpstreamError } from "@maple/domain/http"
import type { UpdateBillingControlsRequest } from "@maple/domain/http"
import { Env } from "@/platform/Env"
import { AUTUMN_API_VERSION } from "./autumn-api"

/**
 * Autumn's REST surface, spoken directly.
 *
 * This replaces `autumn-js`'s `autumnHandler`, which was a thin RPC shim over a
 * Speakeasy-generated SDK: it POSTed `/v1/<op>` with a bearer token, renamed the
 * request keys camel→snake and the response keys snake→camel with Zod, and
 * wrapped the outcome as `{ statusCode, response }`. Everything it did for the
 * six routes we use is reproduced here in ~200 lines, without the ~1.6MB of
 * eagerly-constructed Zod schemas it pulled into the worker's module graph.
 *
 * Wire fidelity is deliberate: the request bodies below (including the defaults
 * the SDK's outbound schemas injected) and the `x-api-version` pin are
 * byte-for-byte what production sends today. The one intentional divergence is
 * that an Autumn 5xx is no longer rewritten into a synthetic 200 — see
 * `callAutumn`.
 */

/** What `autumnHandler` used to return, declared locally now that it's gone. */
export interface AutumnResult {
	readonly statusCode: number
	readonly response: unknown
}

/**
 * Identity fields Autumn accepts on `customers.get_or_create`. Only that route
 * takes them — see the note on `attach`.
 */
export interface AutumnCustomerData {
	readonly name?: string | null
	readonly email?: string | null
	readonly fingerprint?: string | null
	readonly metadata?: Record<string, unknown> | null
}

/** `expand` values accepted by `customers.get_or_create`. */
export type CustomerExpand =
	| "invoices"
	| "invoice_previews"
	| "trials_used"
	| "rewards"
	| "entities"
	| "referrals"
	| "payment_method"
	| "subscriptions.plan"
	| "purchases.plan"
	| "balances.feature"
	| "flags.feature"
	| "billing_controls.auto_topups.purchase_limit"

type AutumnRoute =
	| "getOrCreateCustomer"
	| "aggregateEvents"
	| "attach"
	| "previewAttach"
	| "openCustomerPortal"
	| "listPlans"

const ROUTE_PATHS: Record<AutumnRoute, string> = {
	getOrCreateCustomer: "/v1/customers.get_or_create",
	aggregateEvents: "/v1/events.aggregate",
	attach: "/v1/billing.attach",
	previewAttach: "/v1/billing.preview_attach",
	openCustomerPortal: "/v1/billing.open_customer_portal",
	listPlans: "/v1/plans.list",
} satisfies Record<AutumnRoute, string>

/**
 * Autumn answers in snake_case; every schema in `@maple/domain/http` is
 * camelCase because `autumn-js` renamed the keys for us (Zod
 * `.transform(remap(...))`). Every remap in that SDK was exactly snake→camel,
 * so one deep transform reproduces all of them.
 *
 * Some fields carry keys that are DATA, not schema — feature ids like
 * `browser_sessions` / `product_events` / `ai_input_tokens`, group labels,
 * free-form metadata.
 * Camelizing those would silently break every feature lookup, so they are held
 * back. The SDK's inbound Zod schemas draw the line in two distinct places, and
 * so do we (the field's OWN key is always renamed either way — the SDK remapped
 * `grouped_values` → `groupedValues` while leaving everything under it alone):
 *
 * (a) `MODEL_RECORD_FIELDS` — `record(string, <remapped model>)`. The record's
 *     keys are data, its values are models the SDK remapped, so we keep the keys
 *     and camelize exactly one level down. `balances` is
 *     `record(string, Balance)` and `Balance` remaps `feature_id` → `featureId`;
 *     `flags` is `record(string, Flags)`; `total` (events.aggregate) is
 *     `record(string, { count, sum })`.
 *
 * (b) `OPAQUE_FIELDS` — records of free-form values, scalars, or further
 *     records-of-data. The SDK never descended into these at all, so the whole
 *     subtree passes through verbatim. `metadata` and `properties` are
 *     `record(string, any)` (renaming keys inside them corrupts user data),
 *     `grouped_values` is `record(string, record(string, number))` where BOTH
 *     levels are data, `values` is `record(string, number)`, and `filter_by` is
 *     `record(string, string)` (outbound-only in the SDK — listed for symmetry
 *     so a future inbound echo can't be mangled).
 */
const MODEL_RECORD_FIELDS = new Set(["balances", "flags", "total"])

const OPAQUE_FIELDS = new Set(["metadata", "properties", "grouped_values", "values", "filter_by"])

const toCamel = (key: string): string => key.replace(/_([a-z0-9])/g, (_, char: string) => char.toUpperCase())

export const camelizeKeys = (value: unknown, renameOwnKeys = true): unknown => {
	// An array has no own keys to protect, so its items rename normally even when
	// it sits under a model-record field.
	if (Array.isArray(value)) return value.map((item) => camelizeKeys(item, true))
	if (value === null || typeof value !== "object") return value
	const out: Record<string, unknown> = {}
	for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
		out[renameOwnKeys ? toCamel(key) : key] = OPAQUE_FIELDS.has(key)
			? child
			: camelizeKeys(child, !MODEL_RECORD_FIELDS.has(key))
	}
	return out
}

const toBillingUpstreamError = (error: unknown) =>
	new BillingUpstreamError({
		message: error instanceof Error ? error.message : String(error),
	})

const JsonBody = Schema.fromJsonString(Schema.Unknown)

const decodeJson = Schema.decodeEffect(JsonBody)

/** Total, synchronous JSON parse: `None` where `JSON.parse` would have thrown. */
const parseJsonOption = Schema.decodeUnknownOption(JsonBody)

const trimTrailingSlash = (url: string) => url.replace(/\/+$/, "")

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined

/**
 * Keep the `{ message, code, statusCode }` body the SDK produced for a
 * failed call, so `upstreamMessage` in `autumn-client.ts` still surfaces
 * Autumn's own wording. An unparseable body leaves `message` off entirely
 * rather than inventing one — the caller then falls back to
 * `Billing request failed (<status>)`.
 */
const errorResponse = (statusCode: number, text: string): Record<string, unknown> => {
	const parsed = asRecord(Option.getOrUndefined(parseJsonOption(text)))
	const raw = parsed?.message ?? parsed?.error
	const code = parsed?.code
	return {
		...(typeof raw === "string" ? { message: raw } : undefined),
		code: typeof code === "string" ? code : "autumn_api_error",
		statusCode,
	}
}

const callAutumn = (
	client: HttpClient.HttpClient,
	secretKey: string | undefined,
	apiUrl: string,
	route: AutumnRoute,
	body: Record<string, unknown>,
): Effect.Effect<AutumnResult, BillingUpstreamError> =>
	secretKey === undefined
		? Effect.fail(new BillingUpstreamError({ message: "Billing is not configured" }))
		: Effect.gen(function* () {
				const request = yield* HttpClientRequest.bodyJson(
					HttpClientRequest.post(`${apiUrl}${ROUTE_PATHS[route]}`, {
						// The SDK put `x-api-version` on every one of these routes: its
						// env schema DEFAULTED `AUTUMN_X_API_VERSION` to "2.3.0"
						// (`z._default(z.string(), "2.3.0")`), so an unset variable still
						// pinned the version. Production has been sending 2.3.0 all along
						// — dropping the header would be the untested change, not keeping it.
						headers: {
							Authorization: `Bearer ${secretKey}`,
							"x-api-version": AUTUMN_API_VERSION,
						},
						acceptJson: true,
					}),
					body,
				).pipe(Effect.mapError(toBillingUpstreamError))
				const response = yield* client.execute(request).pipe(Effect.mapError(toBillingUpstreamError))
				const text = yield* response.text.pipe(Effect.mapError(toBillingUpstreamError))
				yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status })

				// 204 never fires for the routes we call, but the SDK mapped it to a
				// null body and the cache round-trips whatever we return.
				if (response.status === 204) return { statusCode: 204, response: null }

				if (response.status >= 200 && response.status < 300) {
					// An empty 2xx body is a failure, not an empty success. The SDK's
					// `JSON.parse("")` threw and the call surfaced as a synthetic 500,
					// which every caller's `ensureOk` turned into a 502. Returning `{}`
					// would instead poison the 5s `getOrCreateCustomer` cache entry and
					// let `attach` answer 200 with no `paymentUrl` (`AttachResult` is
					// all-optional, so `{}` decodes cleanly).
					if (text.length === 0) {
						return yield* new BillingUpstreamError({
							message: `Autumn returned an empty body for ${route} (HTTP ${response.status})`,
						})
					}
					const json = yield* decodeJson(text).pipe(Effect.mapError(toBillingUpstreamError))
					return { statusCode: response.status, response: camelizeKeys(json) }
				}

				// Non-2xx flows through as a result, NOT a failure: `readCustomerCached`
				// and `invalidateCustomer` both branch on `statusCode`. Unlike the SDK
				// we do not fail open — a 5xx stays a 5xx instead of being rewritten
				// into a synthetic 200 with a stub customer.
				return { statusCode: response.status, response: errorResponse(response.status, text) }
			}).pipe(Effect.withSpan("autumn.request", { attributes: { "autumn.route": route } }))

type AutumnCall = Effect.Effect<AutumnResult, BillingUpstreamError>

export interface AutumnClientApi {
	readonly getOrCreateCustomer: (
		customerId: string,
		options: {
			readonly expand: ReadonlyArray<CustomerExpand>
			readonly customerData?: AutumnCustomerData | undefined
		},
	) => AutumnCall
	readonly aggregateEvents: (
		customerId: string,
		options: { readonly featureId: ReadonlyArray<string> | string; readonly range: string },
	) => AutumnCall
	readonly attach: (customerId: string, options: { readonly planId: string }) => AutumnCall
	readonly previewAttach: (customerId: string, options: { readonly planId: string }) => AutumnCall
	readonly openCustomerPortal: (
		customerId: string,
		options: { readonly returnUrl?: string | undefined },
	) => AutumnCall
	readonly listPlans: (customerId: string | undefined) => AutumnCall
	/**
	 * Customer billing controls live on the canonical REST surface — `autumnHandler`
	 * never exposed an RPC route for them, so this call was always hand-rolled. Its
	 * explicit `x-api-version` pin matches the routes above, which send the same
	 * version the SDK defaulted to.
	 */
	readonly updateCustomerBillingControls: (
		orgId: string,
		controls: UpdateBillingControlsRequest,
	) => AutumnCall
}

const customerDataFields = (data: AutumnCustomerData | undefined): Record<string, unknown> =>
	data === undefined
		? {}
		: {
				...(data.name !== undefined ? { name: data.name } : undefined),
				...(data.email !== undefined ? { email: data.email } : undefined),
				...(data.fingerprint !== undefined ? { fingerprint: data.fingerprint } : undefined),
				...(data.metadata !== undefined ? { metadata: data.metadata } : undefined),
			}

/**
 * Customer billing controls live on the canonical REST surface — `autumnHandler`
 * never exposed an RPC route for them, so this call was always hand-rolled. Its
 * explicit `x-api-version` pin now matches the routes above, which send the same
 * version the SDK defaulted to.
 */
const callUpdateBillingControls = (
	client: HttpClient.HttpClient,
	secretKey: string | undefined,
	apiUrl: string,
	orgId: string,
	controls: UpdateBillingControlsRequest,
): Effect.Effect<AutumnResult, BillingUpstreamError> =>
	secretKey === undefined
		? Effect.fail(new BillingUpstreamError({ message: "Billing is not configured" }))
		: Effect.gen(function* () {
				const request = yield* HttpClientRequest.bodyJson(
					HttpClientRequest.post(`${apiUrl}/v1/customers.update`, {
						headers: {
							Authorization: `Bearer ${secretKey}`,
							"x-api-version": AUTUMN_API_VERSION,
						},
					}),
					{
						customer_id: orgId,
						billing_controls: {
							spend_limits: controls.spendLimits.map((limit) => ({
								feature_id: limit.featureId,
								enabled: limit.enabled,
								limit_type: limit.limitType,
								overage_limit: limit.overageLimit,
							})),
							usage_alerts: controls.usageAlerts.map((alert) => ({
								feature_id: alert.featureId,
								enabled: alert.enabled,
								threshold: alert.threshold,
								threshold_type: alert.thresholdType,
								...(alert.name ? { name: alert.name } : undefined),
							})),
						},
					},
				).pipe(Effect.mapError(toBillingUpstreamError))
				const response = yield* client.execute(request).pipe(Effect.mapError(toBillingUpstreamError))
				const text = yield* response.text.pipe(Effect.mapError(toBillingUpstreamError))
				yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status })
				const responseBody =
					text.length === 0
						? {}
						: yield* decodeJson(text).pipe(Effect.mapError(toBillingUpstreamError))
				return { statusCode: response.status, response: responseBody } satisfies AutumnResult
			}).pipe(
				Effect.withSpan("autumn.request", {
					attributes: { "autumn.route": "updateCustomerBillingControls" },
				}),
			)

/**
 * Autumn's REST routes, bound to the worker's credentials and one `HttpClient`.
 *
 * The client is captured at layer build (`Layer.provide(FetchHttpClient.layer)`),
 * so every returned effect is an `Effect<AutumnResult, BillingUpstreamError>`
 * with `R = never` — which is what lets `readCustomerCached` take the call
 * itself, and keeps the billing route groups free of an `HttpClient` requirement.
 *
 * A missing `AUTUMN_SECRET_KEY` is deliberately NOT a layer failure: local dev
 * runs unconfigured and boot must not depend on billing. The unwrap happens once
 * here, the check stays per call.
 */
export class AutumnClient extends Context.Service<AutumnClient, AutumnClientApi>()(
	"@maple/api/services/billing/AutumnClient",
	{
		make: Effect.gen(function* () {
			const env = yield* Env
			const httpClient = yield* HttpClient.HttpClient
			const secretKey = Option.match(env.AUTUMN_SECRET_KEY, {
				onNone: () => undefined,
				onSome: (value) => Redacted.value(value),
			})
			const apiUrl = trimTrailingSlash(env.AUTUMN_API_URL)

			const call = (route: AutumnRoute, body: Record<string, unknown>) =>
				callAutumn(httpClient, secretKey, apiUrl, route, body)

			return {
				getOrCreateCustomer: (customerId, { expand, customerData }) =>
					call("getOrCreateCustomer", {
						customer_id: customerId,
						...customerDataFields(customerData),
						// The SDK's custom handler appended this unconditionally, and the
						// billing UI reads `balances` — keep appending it.
						expand: [...expand, "balances.feature"],
					}),

				aggregateEvents: (customerId, { featureId, range }) =>
					call("aggregateEvents", {
						customer_id: customerId,
						feature_id: featureId,
						range,
						// Zod default on the SDK's outbound params — genuinely on the wire.
						bin_size: "day",
					}),

				// `customer_data` is deliberately absent: `/v1/billing.attach` has no
				// identity fields in API 2.3.0, and the SDK silently discarded the
				// `customerData` we handed it here. Pre-identifying the buyer would need a
				// separate `customers.get_or_create` call on the checkout path — a real
				// change, not a port.
				attach: (customerId, { planId }) =>
					call("attach", {
						customer_id: customerId,
						plan_id: planId,
						redirect_mode: "if_required", // Zod default on the SDK's outbound params.
					}),

				previewAttach: (customerId, { planId }) =>
					call("previewAttach", {
						customer_id: customerId,
						plan_id: planId,
						redirect_mode: "if_required",
					}),

				openCustomerPortal: (customerId, { returnUrl }) =>
					call("openCustomerPortal", {
						customer_id: customerId,
						...(returnUrl !== undefined ? { return_url: returnUrl } : undefined),
					}),

				// The only route Autumn marks customer-optional: an onboarding token gap
				// still serves the public catalog.
				listPlans: (customerId) =>
					call("listPlans", customerId === undefined ? {} : { customer_id: customerId }),

				updateCustomerBillingControls: (orgId, controls) =>
					callUpdateBillingControls(httpClient, secretKey, apiUrl, orgId, controls),
			} satisfies AutumnClientApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(FetchHttpClient.layer))
}

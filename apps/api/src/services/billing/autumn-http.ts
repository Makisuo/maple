import { Effect, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { BillingUpstreamError } from "@maple/domain/http"
import type { UpdateBillingControlsRequest } from "@maple/domain/http"
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
 * the SDK's outbound schemas injected) are byte-for-byte what production sends
 * today. The one intentional divergence is that an Autumn 5xx is no longer
 * rewritten into a synthetic 200 — see `callAutumn`.
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
}

/**
 * Autumn answers in snake_case; every schema in `@maple/domain/http` is
 * camelCase because `autumn-js` renamed the keys for us (Zod
 * `.transform(remap(...))`). Every remap in that SDK was exactly snake→camel,
 * so one deep transform reproduces all of them.
 *
 * `RECORD_KEYED_FIELDS` names fields whose own keys are DATA, not schema —
 * feature ids like `browser_sessions` / `ai_input_tokens`, and free-form
 * metadata. Camelizing those would silently break every feature lookup, so we
 * descend into their values without touching their keys (which is what the SDK
 * did too: `balances` is `record(string, Balance)`, and `Balance` is remapped
 * while its key is not).
 */
const RECORD_KEYED_FIELDS = new Set([
	"balances",
	"flags",
	"metadata",
	"total",
	"values",
	"grouped_values",
	"properties",
	"filter_by",
])

const toCamel = (key: string): string => key.replace(/_([a-z0-9])/g, (_, char: string) => char.toUpperCase())

export const camelizeKeys = (value: unknown, renameOwnKeys = true): unknown => {
	// An array has no own keys to protect, so its items rename normally even when
	// it sits under a record-keyed field.
	if (Array.isArray(value)) return value.map((item) => camelizeKeys(item, true))
	if (value === null || typeof value !== "object") return value
	const out: Record<string, unknown> = {}
	for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
		out[renameOwnKeys ? toCamel(key) : key] = camelizeKeys(child, !RECORD_KEYED_FIELDS.has(key))
	}
	return out
}

const toBillingUpstreamError = (error: unknown) =>
	new BillingUpstreamError({
		message: error instanceof Error ? error.message : String(error),
	})

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))

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
	let parsed: Record<string, unknown> | undefined
	try {
		parsed = asRecord(JSON.parse(text))
	} catch {
		parsed = undefined
	}
	const raw = parsed?.message ?? parsed?.error
	const code = parsed?.code
	return {
		...(typeof raw === "string" ? { message: raw } : {}),
		code: typeof code === "string" ? code : "autumn_api_error",
		statusCode,
	}
}

const callAutumn = (
	secretKey: string | undefined,
	apiUrl: string,
	route: AutumnRoute,
	body: Record<string, unknown>,
): Effect.Effect<AutumnResult, BillingUpstreamError> =>
	secretKey === undefined
		? Effect.fail(new BillingUpstreamError({ message: "Billing is not configured" }))
		: Effect.gen(function* () {
				const client = yield* HttpClient.HttpClient
				const request = yield* HttpClientRequest.bodyJson(
					HttpClientRequest.post(`${trimTrailingSlash(apiUrl)}${ROUTE_PATHS[route]}`, {
						// No `x-api-version`: the SDK never sent one on these routes
						// (the header is only populated from AUTUMN_X_API_VERSION, which
						// is unset), and pinning a version here would be an untested
						// change to the response shapes we decode.
						headers: { Authorization: `Bearer ${secretKey}` },
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
					const json =
						text.length === 0
							? {}
							: yield* decodeJson(text).pipe(Effect.mapError(toBillingUpstreamError))
					return { statusCode: response.status, response: camelizeKeys(json) }
				}

				// Non-2xx flows through as a result, NOT a failure: `readCustomerCached`
				// and `invalidateCustomer` both branch on `statusCode`. Unlike the SDK
				// we do not fail open — a 5xx stays a 5xx instead of being rewritten
				// into a synthetic 200 with a stub customer.
				return { statusCode: response.status, response: errorResponse(response.status, text) }
			}).pipe(
				Effect.withSpan("autumn.request", { attributes: { "autumn.route": route } }),
				// Provided inline (rather than required from context) so the billing
				// route layers keep their current requirements and `readCustomerCached`
				// keeps taking an `Effect<AutumnResult, BillingUpstreamError>`.
				Effect.provide(FetchHttpClient.layer),
			)

type AutumnCall = Effect.Effect<AutumnResult, BillingUpstreamError>

export interface AutumnClient {
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
}

const customerDataFields = (data: AutumnCustomerData | undefined): Record<string, unknown> =>
	data === undefined
		? {}
		: {
				...(data.name !== undefined ? { name: data.name } : {}),
				...(data.email !== undefined ? { email: data.email } : {}),
				...(data.fingerprint !== undefined ? { fingerprint: data.fingerprint } : {}),
				...(data.metadata !== undefined ? { metadata: data.metadata } : {}),
			}

/**
 * Bind the credentials once; the routes are plain functions returning the same
 * `{ statusCode, response }` result the old `callAutumn` did.
 */
export const makeAutumnClient = (secretKey: string | undefined, apiUrl: string): AutumnClient => {
	const call = (route: AutumnRoute, body: Record<string, unknown>) =>
		callAutumn(secretKey, apiUrl, route, body)

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
				...(returnUrl !== undefined ? { return_url: returnUrl } : {}),
			}),

		// The only route Autumn marks customer-optional: an onboarding token gap
		// still serves the public catalog.
		listPlans: (customerId) =>
			call("listPlans", customerId === undefined ? {} : { customer_id: customerId }),
	}
}

/**
 * Customer billing controls live on the canonical REST surface — `autumnHandler`
 * never exposed an RPC route for them, so this call was always hand-rolled. It
 * keeps its explicit `x-api-version` pin (the RPC-equivalent routes above send
 * none, matching what the SDK did).
 */
export const updateCustomerBillingControls = (
	secretKey: string | undefined,
	apiUrl: string,
	orgId: string,
	controls: UpdateBillingControlsRequest,
): Effect.Effect<AutumnResult, BillingUpstreamError> =>
	secretKey === undefined
		? Effect.fail(new BillingUpstreamError({ message: "Billing is not configured" }))
		: Effect.gen(function* () {
				const client = yield* HttpClient.HttpClient
				const request = yield* HttpClientRequest.bodyJson(
					HttpClientRequest.post(`${trimTrailingSlash(apiUrl)}/v1/customers.update`, {
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
								...(alert.name ? { name: alert.name } : {}),
							})),
						},
					},
				).pipe(Effect.mapError(toBillingUpstreamError))
				const response = yield* client.execute(request).pipe(Effect.mapError(toBillingUpstreamError))
				const text = yield* response.text.pipe(Effect.mapError(toBillingUpstreamError))
				const responseBody =
					text.length === 0
						? {}
						: yield* decodeJson(text).pipe(Effect.mapError(toBillingUpstreamError))
				return { statusCode: response.status, response: responseBody } satisfies AutumnResult
			}).pipe(Effect.provide(FetchHttpClient.layer))

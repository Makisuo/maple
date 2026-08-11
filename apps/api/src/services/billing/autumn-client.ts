import { Effect, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { autumnHandler, type CustomerData } from "autumn-js/backend"
import type { EdgeCacheServiceShape } from "@maple/cache"
import { isActivePlanSubscription } from "@maple/domain/billing"
import { BillingUpstreamError } from "@maple/domain/http"
import type { UpdateBillingControlsRequest } from "@maple/domain/http"
import { AUTUMN_API_VERSION } from "./autumn-api"

/**
 * Autumn plumbing shared by the billing routes.
 *
 * Lives outside `routes/billing.http.ts` so the customer cache and canonical
 * Autumn REST mutations share one boundary. Everything here is a plain function:
 * the caller owns the secret key and cache instance.
 */

export type AutumnResult = Awaited<ReturnType<typeof autumnHandler>>

// `autumnHandler` matches its route by `method` + `path`, always POST against
// `${DEFAULT_PATH_PREFIX}/${route}` (= /api/autumn/<route>) regardless of which
// Maple endpoint fronts it, so every call here speaks that internal contract.
const AUTUMN_PATH_PREFIX = "/api/autumn"

// getOrCreateCustomer fires on every page load (hot path) and its latency is
// dominated by the upstream Autumn call. Cache its success response per org for
// 5 minutes behind the shared edge cache (single-flight dedup collapses
// concurrent misses), invalidated after any billing mutation.
export const CUSTOMER_CACHE_BUCKET = "autumn-customer"
export const CUSTOMER_CACHE_TTL_SECONDS = 300

// Short TTL for a customer with no active plan: caching that "no plan" snapshot
// for the full 5 min would strand a just-subscribed user on the /quick-start
// gate until the post-checkout Stripe→Autumn sync lands. Re-check soon instead.
export const CUSTOMER_CACHE_UNSETTLED_TTL_SECONDS = 5

/**
 * Does this raw `getOrCreateCustomer` response carry an active, non-add-on,
 * non-free plan? Delegates to the shared `isActivePlanSubscription` gate
 * (@maple/domain/billing) so the cache TTL can't drift from the web redirect gate.
 */
export const responseHasActivePlan = (response: unknown): boolean => {
	if (typeof response !== "object" || response === null) return false
	const subscriptions = (response as { subscriptions?: unknown }).subscriptions
	if (!Array.isArray(subscriptions)) return false
	return subscriptions.some((sub) => isActivePlanSubscription(sub))
}

// Sentinel keeping non-200 Autumn responses out of the edge cache: the compute
// fails with this so `getOrCompute` never stores it, then the caller recovers it
// into the normal path. Mirrors `AutumnResult` so `.result` stays typed.
class UncacheableAutumnResult extends Schema.TaggedError<UncacheableAutumnResult>()(
	"@maple/api/billing/UncacheableAutumnResult",
	{
		result: Schema.Struct({ statusCode: Schema.Number, response: Schema.Unknown }),
	},
) {}

/**
 * Run `getOrCreateCustomer` through the per-org edge cache (200-only). Active-plan
 * 200s get the full TTL; planless ones a short TTL so the gate re-checks soon
 * after a post-checkout sync. Returns the resolved result plus whether it came
 * from the cache (for span annotation).
 */
export const readCustomerCached = (
	edgeCache: Pick<EdgeCacheServiceShape, "getOrCompute">,
	orgId: string,
	runAutumn: Effect.Effect<AutumnResult, BillingUpstreamError>,
): Effect.Effect<{ readonly result: AutumnResult; readonly hit: boolean }, BillingUpstreamError> =>
	edgeCache
		.getOrCompute(
			{
				bucket: CUSTOMER_CACHE_BUCKET,
				key: orgId,
				ttlSeconds: (result: AutumnResult) =>
					responseHasActivePlan(result.response)
						? CUSTOMER_CACHE_TTL_SECONDS
						: CUSTOMER_CACHE_UNSETTLED_TTL_SECONDS,
			},
			runAutumn.pipe(
				Effect.flatMap((res) =>
					res.statusCode === 200
						? Effect.succeed(res)
						: Effect.fail(new UncacheableAutumnResult({ result: res })),
				),
			),
		)
		.pipe(
			Effect.map((cached) => ({ result: cached.value, hit: cached.hit })),
			Effect.catchTag("@maple/api/billing/UncacheableAutumnResult", (error) =>
				Effect.succeed({ result: error.result, hit: false }),
			),
		)

export const makeCallAutumn =
	(secretKey: string | undefined) =>
	(
		route: string,
		body: unknown,
		customerId: string | undefined,
		customerData?: CustomerData,
	): Effect.Effect<AutumnResult, BillingUpstreamError> =>
		secretKey === undefined
			? Effect.fail(new BillingUpstreamError({ message: "Billing is not configured" }))
			: Effect.tryPromise({
					try: () =>
						autumnHandler({
							request: { url: `${AUTUMN_PATH_PREFIX}/${route}`, method: "POST", body },
							customerId,
							customerData,
							clientOptions: { secretKey },
						}),
					catch: (error) =>
						new BillingUpstreamError({
							message: error instanceof Error ? error.message : String(error),
						}),
				})

const toBillingUpstreamError = (error: unknown) =>
	new BillingUpstreamError({
		message: error instanceof Error ? error.message : String(error),
	})

/**
 * `autumnHandler` intentionally exposes only its RPC route list; customer
 * billing controls live on the canonical REST surface instead.
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
					HttpClientRequest.post(`${apiUrl.replace(/\/+$/, "")}/v1/customers.update`, {
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
						: yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
								Effect.mapError(toBillingUpstreamError),
							)
				return { statusCode: response.status, response: responseBody } as AutumnResult
			}).pipe(Effect.provide(FetchHttpClient.layer))

// Surface a readable message for a non-2xx Autumn response (it carries a
// `{ message }` / `{ error }` body) so the client error isn't an opaque 502.
const upstreamMessage = (result: AutumnResult): string => {
	const body = result.response as { message?: unknown; error?: unknown } | null
	const message = body?.message ?? body?.error
	return typeof message === "string" ? message : `Billing request failed (${result.statusCode})`
}

export const ensureOk = (result: AutumnResult): Effect.Effect<unknown, BillingUpstreamError> =>
	result.statusCode >= 200 && result.statusCode < 300
		? Effect.succeed(result.response)
		: Effect.fail(new BillingUpstreamError({ message: upstreamMessage(result) }))

export const decodeUpstream = <S extends Schema.Top>(
	schema: S,
	value: unknown,
): Effect.Effect<S["Type"], BillingUpstreamError, S["DecodingServices"]> =>
	Schema.decodeUnknownEffect(schema)(value).pipe(
		Effect.mapError(
			(error) => new BillingUpstreamError({ message: `Unexpected billing response: ${error}` }),
		),
	)

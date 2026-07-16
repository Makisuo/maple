import { HttpApiBuilder } from "effect/unstable/httpapi"
import { HttpServerRequest } from "effect/unstable/http"
import { Effect, Option, Redacted, Schema } from "effect"
import { autumnHandler, type CustomerData } from "autumn-js/backend"
import { EdgeCacheService, type EdgeCacheServiceShape } from "@maple/query-engine/caching"
import { isActivePlanSubscription } from "@maple/domain/billing"
import {
	AttachResult,
	BillingCustomer,
	BillingInvoice,
	BillingInvoicesResponse,
	BillingUpstreamError,
	BillingUsage,
	CatalogPlan,
	CatalogPlansResponse,
	CurrentTenant,
	CustomerPortalResult,
	MapleApi,
	PreviewAttachResult,
} from "@maple/domain/http"
import { Env } from "../lib/Env"
import { AuthService, type AuthServiceShape } from "../services/AuthService"

type AutumnResult = Awaited<ReturnType<typeof autumnHandler>>

// `autumnHandler` matches its route by `method` + `path`, always POST against
// `${DEFAULT_PATH_PREFIX}/${route}` (= /api/autumn/<route>) regardless of which
// Maple endpoint fronts it, so every call here speaks that internal contract.
const AUTUMN_PATH_PREFIX = "/api/autumn"

// getOrCreateCustomer fires on every page load (hot path) and its latency is
// dominated by the upstream Autumn call. Cache its success response per org for
// 5 minutes behind the shared edge cache (single-flight dedup collapses
// concurrent misses), invalidated after any billing mutation. Ported from the
// retired autumn.http.ts proxy.
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
// into the normal path. Mirrors `AutumnHandlerResult` so `.result` stays typed.
class UncacheableAutumnResult extends Schema.TaggedErrorClass<UncacheableAutumnResult>()(
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

const makeCallAutumn =
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

// Surface a readable message for a non-2xx Autumn response (it carries a
// `{ message }` / `{ error }` body) so the client error isn't an opaque 502.
const upstreamMessage = (result: AutumnResult): string => {
	const body = result.response as { message?: unknown; error?: unknown } | null
	const message = body?.message ?? body?.error
	return typeof message === "string" ? message : `Billing request failed (${result.statusCode})`
}

const ensureOk = (result: AutumnResult): Effect.Effect<unknown, BillingUpstreamError> =>
	result.statusCode >= 200 && result.statusCode < 300
		? Effect.succeed(result.response)
		: Effect.fail(new BillingUpstreamError({ message: upstreamMessage(result) }))

const decodeUpstream = <S extends Schema.Top>(
	schema: S,
	value: unknown,
): Effect.Effect<S["Type"], BillingUpstreamError, S["DecodingServices"]> =>
	Schema.decodeUnknownEffect(schema)(value).pipe(
		Effect.mapError(
			(error) => new BillingUpstreamError({ message: `Unexpected billing response: ${error}` }),
		),
	)

// Pull the `invoices` array off a raw expanded `getOrCreateCustomer` response.
// Exported for tests. Autumn omits the key for a customer with no invoices, so
// an absent/null field decodes as an empty list rather than a 502.
export const decodeInvoices = (
	response: unknown,
): Effect.Effect<BillingInvoicesResponse, BillingUpstreamError> => {
	const invoices = (response as { invoices?: unknown } | null)?.invoices ?? []
	return decodeUpstream(Schema.Array(BillingInvoice), invoices).pipe(
		Effect.map((decoded) => new BillingInvoicesResponse({ invoices: decoded })),
	)
}

// Enrich checkout (attach) with Clerk-resolved identity so the customer is
// identified before Stripe and the buyer's email is pre-filled. Ported verbatim
// from the retired proxy's ENRICHED_ROUTES handling.
const resolveCustomerData = (
	auth: AuthServiceShape,
	tenant: Parameters<AuthServiceShape["getCustomerData"]>[0],
): Effect.Effect<CustomerData | undefined> =>
	auth.getCustomerData(tenant).pipe(
		Effect.map(({ email, orgName }) =>
			email || orgName
				? {
						email,
						name: orgName,
						fingerprint: tenant.orgId,
						metadata: { maple_user_id: String(tenant.userId), maple_user_email: email },
					}
				: undefined,
		),
	)

export const HttpBillingLive = HttpApiBuilder.group(MapleApi, "billing", (handlers) =>
	Effect.gen(function* () {
		const env = yield* Env
		const auth = yield* AuthService
		const edgeCache = yield* EdgeCacheService
		const secretKey = Option.match(env.AUTUMN_SECRET_KEY, {
			onNone: () => undefined,
			onSome: (value) => Redacted.value(value),
		})
		const callAutumn = makeCallAutumn(secretKey)

		// Invalidate on any 2xx, matching `ensureOk` — otherwise a 201/204 from
		// attach/openCustomerPortal would decode as success yet leave the stale
		// cached customer in place for up to the TTL.
		const invalidateCustomer = (orgId: string, result: AutumnResult) =>
			result.statusCode >= 200 && result.statusCode < 300
				? edgeCache.invalidate({ bucket: CUSTOMER_CACHE_BUCKET, key: orgId })
				: Effect.void

		return handlers
			.handle("getCustomer", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const { result, hit } = yield* readCustomerCached(
						edgeCache,
						tenant.orgId,
						callAutumn("getOrCreateCustomer", {}, tenant.orgId),
					)
					yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, "cache.hit": hit })
					const response = yield* ensureOk(result)
					return yield* decodeUpstream(BillingCustomer, response)
				}),
			)
			.handle("getUsage", ({ query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const result = yield* callAutumn(
						"aggregateEvents",
						{ featureId: query.featureId, range: query.range },
						tenant.orgId,
					)
					const response = yield* ensureOk(result)
					return yield* decodeUpstream(BillingUsage, response)
				}),
			)
			// Invoices ride along on getOrCreateCustomer via `expand`, but through a
			// dedicated endpoint (not the cached hot-path customer read): the customer
			// atom is fetched on every page and edge-cached 5 min, while the invoice
			// list is a settings-only read where an "open" invoice must show promptly.
			.handle("listInvoices", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const result = yield* callAutumn(
						"getOrCreateCustomer",
						{ expand: ["invoices"] },
						tenant.orgId,
					)
					yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
					const response = yield* ensureOk(result)
					return yield* decodeInvoices(response)
				}),
			)
			.handle("attach", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const customerData = yield* resolveCustomerData(auth, tenant)
					const result = yield* callAutumn(
						"attach",
						{ planId: payload.planId },
						tenant.orgId,
						customerData,
					)
					const response = yield* ensureOk(result)
					yield* invalidateCustomer(tenant.orgId, result)
					return yield* decodeUpstream(AttachResult, response)
				}),
			)
			.handle("previewAttach", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const result = yield* callAutumn("previewAttach", { planId: payload.planId }, tenant.orgId)
					const response = yield* ensureOk(result)
					return yield* decodeUpstream(PreviewAttachResult, response)
				}),
			)
			.handle("openCustomerPortal", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const result = yield* callAutumn(
						"openCustomerPortal",
						{ returnUrl: payload.returnUrl },
						tenant.orgId,
					)
					const response = yield* ensureOk(result)
					yield* invalidateCustomer(tenant.orgId, result)
					return yield* decodeUpstream(CustomerPortalResult, response)
				}),
			)
	}),
)

export const HttpBillingPublicLive = HttpApiBuilder.group(MapleApi, "billingPublic", (handlers) =>
	Effect.gen(function* () {
		const env = yield* Env
		const auth = yield* AuthService
		const secretKey = Option.match(env.AUTUMN_SECRET_KEY, {
			onNone: () => undefined,
			onSome: (value) => Redacted.value(value),
		})
		const callAutumn = makeCallAutumn(secretKey)

		return handlers.handle("listPlans", () =>
			Effect.gen(function* () {
				// Public route: resolve the tenant optionally so an onboarding token gap
				// still serves the catalog, while authed callers get per-customer
				// `customerEligibility` (autumn marks listPlans' customerId optional).
				const req = yield* HttpServerRequest.HttpServerRequest
				const tenant = yield* Effect.option(
					auth.resolveTenant(req.headers as Record<string, string>),
				)
				const customerId = Option.getOrUndefined(tenant)?.orgId
				const result = yield* callAutumn("listPlans", {}, customerId)
				const response = yield* ensureOk(result)
				// The autumn SDK wraps the catalog as `{ list: [...] }`.
				const list = (response as { list?: unknown })?.list ?? response
				const plans = yield* decodeUpstream(Schema.Array(CatalogPlan), list)
				return new CatalogPlansResponse({ plans })
			}),
		)
	}),
)

import { Effect, Schema } from "effect"
import type { EdgeCacheServiceApi } from "@maple/cache"
import {
	isActivePlanSubscription,
	isPlanSubscription,
	type PlanGatingSubscription,
} from "@maple/domain/billing"
import {
	BillingConflictError,
	BillingCustomer,
	BillingNotConfiguredError,
	BillingPaymentRequiredError,
	BillingRateLimitedError,
	BillingRequestError,
	BillingUpstreamError,
} from "@maple/domain/http"
import type { AutumnFailure } from "@maple/domain/http"
import type { AutumnResult, AutumnTransportFailure } from "./autumn-http"

/**
 * Caching and decoding plumbing shared by the billing routes.
 *
 * Lives outside `routes/billing.http.ts` so the customer cache and the upstream
 * result handling share one boundary; the calls themselves live in
 * `autumn-http.ts`. Everything here is a plain function: the caller owns the
 * secret key and cache instance.
 */

// getOrCreateCustomer fires on every page load (hot path) and its latency is
// dominated by the upstream Autumn call. Cache its success response per org for
// 5 minutes behind the shared edge cache (single-flight dedup collapses
// concurrent misses), invalidated after any billing mutation.
export const CUSTOMER_CACHE_BUCKET = "autumn-customer"
export const CUSTOMER_CACHE_TTL_SECONDS = 300

// Short TTL for a customer with no plan history at all: this org is mid-signup
// and about to check out, and caching that "no plan" snapshot for the full 5 min
// would strand it on the /quick-start gate until the post-checkout Stripe→Autumn
// sync lands. Re-check almost immediately instead.
export const CUSTOMER_CACHE_UNSETTLED_TTL_SECONDS = 5

// A lapsed customer (held a plan, holds none now) is planless *durably* — that
// state normally persists for weeks, so the 5s unsettled TTL would send every
// one of their page loads upstream (p50 ~94ms, p95 ~603ms) for an answer that
// hasn't changed. They browse the app now rather than being parked on the
// onboarding gate, so this is a real hot path. A minute keeps a resubscribe
// visible promptly — `attach` also invalidates the entry outright — while
// cutting the upstream call rate ~12x.
export const CUSTOMER_CACHE_LAPSED_TTL_SECONDS = 60

/**
 * Does this raw `getOrCreateCustomer` response carry an active, non-add-on,
 * non-free plan? Delegates to the shared `isActivePlanSubscription` gate
 * (@maple/domain/billing) so the cache TTL can't drift from the web redirect gate.
 */
export const responseHasActivePlan = (response: unknown): boolean =>
	subscriptionsOf(response).some(isActivePlanSubscription)

/**
 * Has this org ever held a real plan, whatever its status? Mirrors the web
 * `hasLapsedPlan` gate — together with `responseHasActivePlan` it separates a
 * never-subscribed org (short TTL, checkout imminent) from a lapsed one
 * (durably planless, so worth caching).
 */
export const responseHasPlanHistory = (response: unknown): boolean =>
	subscriptionsOf(response).some(isPlanSubscription)

// Every field of `PlanGatingSubscription` is optional, so "is an object" is the
// whole shape check — the gating predicates answer for themselves what a missing
// `status` or `planId` means. Anything else in the array is not a subscription.
const isSubscriptionLike = (value: unknown): value is PlanGatingSubscription =>
	typeof value === "object" && value !== null

const subscriptionsOf = (response: unknown): ReadonlyArray<PlanGatingSubscription> => {
	if (typeof response !== "object" || response === null) return []
	const subscriptions = (response as { subscriptions?: unknown }).subscriptions
	return Array.isArray(subscriptions) ? subscriptions.filter(isSubscriptionLike) : []
}

/**
 * A PII-free description of the subscription rows Autumn returned, for the
 * `getCustomer` span.
 *
 * The plan gate ("does this org see the app or the new-user wizard?") is derived
 * entirely from this array, so when an org is gated wrongly the array is the
 * only thing worth looking at — and it is upstream data we otherwise never
 * record. Statuses and plan ids are catalog identifiers, not customer data.
 */
export const summariseSubscriptions = (response: unknown): Record<string, string | number | boolean> => {
	const subscriptions = subscriptionsOf(response)
	// A row is positional: a missing field reads as "-" so the lists stay aligned.
	const describe = (pick: (sub: PlanGatingSubscription) => string | null | undefined) =>
		subscriptions.map((sub) => pick(sub) ?? "-").join(",")
	return {
		"billing.subscription_count": subscriptions.length,
		"billing.subscription_statuses": describe((sub) => sub.status),
		"billing.subscription_plan_ids": describe((sub) => sub.planId),
		// Which rows the gate discards, positionally aligned with the two lists
		// above: "addon" / "auto" / "-" per subscription.
		"billing.subscription_excluded": subscriptions
			.map((sub) => (sub.addOn ? "addon" : sub.autoEnable ? "auto" : "-"))
			.join(","),
		"billing.has_active_plan": responseHasActivePlan(response),
		"billing.has_plan_history": responseHasPlanHistory(response),
	}
}

/**
 * How long a `getOrCreateCustomer` response stays cached. Three tiers, because
 * "no active plan" covers two states with opposite cache economics: an org
 * seconds away from its first checkout, and one that lapsed weeks ago.
 */
const customerCacheTtl = (response: unknown): number => {
	if (responseHasActivePlan(response)) return CUSTOMER_CACHE_TTL_SECONDS
	if (responseHasPlanHistory(response)) return CUSTOMER_CACHE_LAPSED_TTL_SECONDS
	return CUSTOMER_CACHE_UNSETTLED_TTL_SECONDS
}

// Sentinel keeping non-200 Autumn responses out of the edge cache: the compute
// fails with this so `getOrCompute` never stores it, then the caller recovers it
// into the normal path. Mirrors `AutumnResult` so `.result` stays typed.
class UncacheableAutumnResult extends Schema.TaggedError<UncacheableAutumnResult>()(
	"@maple/api/billing/UncacheableAutumnResult",
	{
		message: Schema.String,
		result: Schema.Struct({ statusCode: Schema.Number, response: Schema.Unknown }),
	},
) {}

/**
 * Run `getOrCreateCustomer` through the per-org edge cache (200-only), on the
 * tiered TTL above. Returns the resolved result plus whether it came from the
 * cache (for span annotation).
 */
export const readCustomerCached = (
	edgeCache: Pick<EdgeCacheServiceApi, "getOrCompute">,
	orgId: string,
	runAutumn: Effect.Effect<AutumnResult, AutumnTransportFailure>,
): Effect.Effect<{ readonly result: AutumnResult; readonly hit: boolean }, AutumnTransportFailure> =>
	edgeCache
		.getOrCompute(
			{
				bucket: CUSTOMER_CACHE_BUCKET,
				key: orgId,
				ttlSeconds: (result: AutumnResult) => customerCacheTtl(result.response),
			},
			runAutumn.pipe(
				Effect.flatMap((res) =>
					res.statusCode === 200
						? Effect.succeed(res)
						: Effect.fail(
								new UncacheableAutumnResult({
									message: `Autumn returned HTTP ${res.statusCode}; response must not be cached`,
									result: res,
								}),
							),
				),
			),
		)
		.pipe(
			Effect.map((cached) => ({ result: cached.value, hit: cached.hit })),
			Effect.catchTag("@maple/api/billing/UncacheableAutumnResult", (error) =>
				Effect.succeed({ result: error.result, hit: false }),
			),
		)

// Surface a readable message for a non-2xx Autumn response (it carries a
// `{ message }` / `{ error }` body) so the client error isn't an opaque 502.
const upstreamMessage = (result: AutumnResult): string => {
	const body = result.response as { message?: unknown; error?: unknown } | null
	const message = body?.message ?? body?.error
	return typeof message === "string" ? message : `Billing request failed (${result.statusCode})`
}

// Autumn's own error identifier. `errorResponse` in `autumn-http.ts` always
// stamps one (falling back to "autumn_api_error"), but this is defensive: the
// value crosses a boundary marked as carrying opaque data.
const upstreamCode = (result: AutumnResult): string => {
	const code = (result.response as { code?: unknown } | null)?.code
	return typeof code === "string" ? code : "autumn_api_error"
}

/**
 * Turn an Autumn response into a success value or a *classified* failure.
 *
 * The status class is the only signal we can trust here — Autumn's `code`
 * vocabulary is theirs to extend, so it rides along as context rather than
 * driving the branch. Anything that is not a recognised 4xx, including every
 * 5xx, stays `BillingUpstreamError` (502).
 *
 * Callers that take user input use this directly. Pure reads use {@link ensureOk}.
 */
export const classifyAutumn = (result: AutumnResult): Effect.Effect<unknown, AutumnFailure> => {
	if (result.statusCode >= 200 && result.statusCode < 300) return Effect.succeed(result.response)

	const context = {
		message: upstreamMessage(result),
		code: upstreamCode(result),
		upstreamStatus: result.statusCode,
	}

	switch (result.statusCode) {
		case 401:
		case 403:
			// Autumn rejected OUR credentials — a revoked or rotated key. Never the
			// caller's fault, so it must not become a 400: that would both blame the
			// shopper and, because 4xx spans record as Ok, hide a total checkout
			// outage from error tracking. Same operator remedy as a missing key.
			return Effect.fail(
				new BillingNotConfiguredError({
					message: `Autumn rejected our credentials (HTTP ${result.statusCode}, ${context.code})`,
				}),
			)
		case 402:
			return Effect.fail(new BillingPaymentRequiredError(context))
		case 409:
			return Effect.fail(new BillingConflictError(context))
		case 429:
			return Effect.fail(new BillingRateLimitedError(context))
	}

	return result.statusCode >= 400 && result.statusCode < 500
		? Effect.fail(new BillingRequestError(context))
		: Effect.fail(new BillingUpstreamError({ message: context.message }))
}

/**
 * Classify, then collapse the caller-input failures back into a 502.
 *
 * For an endpoint that sends no user input — `getCustomer`, `getUsage`,
 * `listInvoices`, `listPlans`, `openCustomerPortal` — an upstream 4xx means
 * *we* built a bad request. Answering the browser with a 400/402/409 would
 * blame a caller who supplied nothing, so those endpoints keep reporting 502
 * and the real status stays visible on the `autumn.request` span (which carries
 * `http.response.status_code` and `autumn.code`). Nothing is lost by collapsing
 * here; the diagnosis lives in telemetry, where it belongs.
 */
export const ensureOk = (
	result: AutumnResult,
): Effect.Effect<unknown, BillingUpstreamError | BillingNotConfiguredError> =>
	classifyAutumn(result).pipe(
		Effect.catchTags({
			"@maple/http/errors/BillingPaymentRequiredError": collapseToUpstream,
			"@maple/http/errors/BillingConflictError": collapseToUpstream,
			"@maple/http/errors/BillingRateLimitedError": collapseToUpstream,
			"@maple/http/errors/BillingRequestError": collapseToUpstream,
		}),
	)

const collapseToUpstream = (error: {
	readonly message: string
	readonly code: string
	readonly upstreamStatus: number
}) =>
	Effect.fail(
		new BillingUpstreamError({
			message: `Autumn rejected our request (HTTP ${error.upstreamStatus}, ${error.code}): ${error.message}`,
		}),
	)

/**
 * Decide whether an attach conflict is really "you already bought this".
 *
 * Re-reads the customer instead of trusting the 409, then asks the narrow
 * question: is there an active subscription for THIS plan id? Deliberately not
 * `isActivePlanSubscription` — that helper answers "should we redirect to
 * quick-start", so it excludes add-ons and free tiers, which are perfectly
 * legitimate things to have just attached.
 *
 * A match resolves to an empty `AttachResult` — no `paymentUrl`, which is
 * exactly what an attach needing no redirect returns. Anything else re-fails
 * with the original conflict: 409 is not exclusively "already attached".
 */
export const resolveAttachConflict = (
	refreshCustomer: Effect.Effect<AutumnResult, AutumnTransportFailure>,
	planId: string,
	conflict: BillingConflictError,
): Effect.Effect<unknown, AutumnFailure> =>
	Effect.gen(function* () {
		const refreshed = yield* refreshCustomer
		if (refreshed.statusCode < 200 || refreshed.statusCode >= 300) return yield* conflict
		const customer = yield* decodeUpstream(BillingCustomer, refreshed.response)
		const holdsPlan = customer.subscriptions.some(
			(sub) => sub.planId === planId && sub.status === "active",
		)
		yield* Effect.annotateCurrentSpan({ "billing.attach_conflict_resolved": holdsPlan })
		return holdsPlan ? {} : yield* conflict
	})

export const decodeUpstream = <S extends Schema.Top>(
	schema: S,
	value: unknown,
): Effect.Effect<S["Type"], BillingUpstreamError, S["DecodingServices"]> =>
	Schema.decodeUnknownEffect(schema)(value).pipe(
		Effect.mapError(
			(error) => new BillingUpstreamError({ message: `Unexpected billing response: ${error}` }),
		),
	)

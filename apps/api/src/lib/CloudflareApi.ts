/**
 * Thin, token-keyed wrapper around `@distilled.cloud/cloudflare` (the Effect-native Cloudflare SDK).
 *
 * This is the ONLY module in the app that imports the distilled SDK — everything else goes through the
 * helpers here (mirrors how `WarehouseQueryService` isolates the ClickHouse/Tinybird drivers). Keeping
 * the SDK behind one wrapper means callers deal in Maple domain errors, not distilled's tagged-error
 * union, and we can swap the transport (e.g. the raw `HttpClient` escape hatch for endpoints the SDK
 * does not cover, like GraphQL Analytics) without touching call sites.
 *
 * The wrapper is intentionally **stateless and keyed on an access token** rather than depending on
 * `CloudflareOAuthService`: the OAuth service itself needs `listAccounts` during `completeConnect`
 * (before a connection row exists), so a service-level dependency would be circular. Callers that
 * already have a connection resolve a fresh token via `CloudflareOAuthService.getValidAccessToken`
 * and pass it in.
 */
import { API, T, type DefaultErrors } from "@distilled.cloud/cloudflare"
import * as Accounts from "@distilled.cloud/cloudflare/accounts"
import { fromOAuth, type Credentials } from "@distilled.cloud/cloudflare/Credentials"
import * as Zones from "@distilled.cloud/cloudflare/zones"
import { IntegrationsRevokedError, IntegrationsUpstreamError } from "@maple/domain/http"
import { Effect, Layer, Schema, Stream } from "effect"
import { FetchHttpClient, type HttpClient } from "effect/unstable/http"

/** The Effect context a distilled operation requires: resolved credentials + an HTTP client. */
type CloudflareRequirements = Credentials | HttpClient.HttpClient

/** Any failure a Cloudflare API call can surface to callers, mapped onto Maple's integration errors. */
export type CloudflareApiError = IntegrationsUpstreamError | IntegrationsRevokedError

const credentialsLayer = (accessToken: string, apiBaseUrl?: string): Layer.Layer<Credentials> =>
	fromOAuth({
		// The token is already validated/refreshed by CloudflareOAuthService before it reaches us, so
		// `load` is a constant and `refresh` is a no-op passthrough — a single request never outlives the
		// access-token TTL. If that assumption ever breaks, wire `refresh` to the token endpoint here.
		load: Effect.succeed({ accessToken }),
		refresh: (credentials) => Effect.succeed(credentials),
		// Defaults to https://api.cloudflare.com/client/v4; overridable (CLOUDFLARE_API_BASE_URL) so
		// local dev / tests can point the SDK at a mock.
		...(apiBaseUrl ? { apiBaseUrl } : {}),
	})

const runtimeLayer = (accessToken: string, apiBaseUrl?: string): Layer.Layer<CloudflareRequirements> =>
	Layer.mergeAll(credentialsLayer(accessToken, apiBaseUrl), FetchHttpClient.layer)

const readTag = (error: unknown): unknown =>
	typeof error === "object" && error !== null && "_tag" in error
		? (error as { _tag?: unknown })._tag
		: undefined

const readStatus = (error: unknown): number | undefined => {
	if (typeof error === "object" && error !== null && "status" in error) {
		const status = (error as { status?: unknown }).status
		if (typeof status === "number") return status
	}
	return undefined
}

const readMessage = (error: unknown): string => {
	if (error instanceof Error) return error.message
	if (typeof error === "object" && error !== null && "message" in error) {
		const message = (error as { message?: unknown }).message
		if (typeof message === "string" && message.length > 0) return message
	}
	return "Cloudflare API request failed"
}

/** Collapse distilled's tagged-error union into a Maple domain error, flagging auth failures as revoked. */
const mapCloudflareError = (error: unknown): CloudflareApiError => {
	const status = readStatus(error)
	const tag = readTag(error)
	if (status === 401 || status === 403 || tag === "Unauthorized" || tag === "Forbidden") {
		return new IntegrationsRevokedError({
			message: "Cloudflare rejected the access token — reconnect the integration",
		})
	}
	return new IntegrationsUpstreamError({
		message: readMessage(error),
		...(status === undefined ? {} : { status }),
		cause: error,
	})
}

/**
 * Provide the credentials + HTTP layers to a distilled operation and run it. Errors are left untouched
 * so callers that need to branch on a specific tag (e.g. `JobNotFound` for delete idempotency) can do
 * so; most callers pipe the result through {@link runMapped}. Kept internal until a second consumer
 * (Phase 2 Workers provisioning) needs it exported.
 */
const runWithToken = <A, E>(
	accessToken: string,
	effect: Effect.Effect<A, E, CloudflareRequirements>,
	apiBaseUrl?: string,
): Effect.Effect<A, E, never> => effect.pipe(Effect.provide(runtimeLayer(accessToken, apiBaseUrl)))

/** Like {@link runWithToken} but collapses the distilled error union to a Maple domain error. */
const runMapped = <A, E>(
	accessToken: string,
	effect: Effect.Effect<A, E, CloudflareRequirements>,
	apiBaseUrl?: string,
): Effect.Effect<A, CloudflareApiError, never> =>
	runWithToken(accessToken, effect, apiBaseUrl).pipe(Effect.mapError(mapCloudflareError))

export interface CloudflareAccount {
	readonly id: string
	readonly name: string
	readonly type: string
}

/**
 * List the Cloudflare accounts the token can access. Used by the OAuth `completeConnect` flow to resolve
 * (and enforce a single) account for the org.
 */
export const listAccounts: (
	accessToken: string,
	apiBaseUrl?: string,
) => Effect.Effect<ReadonlyArray<CloudflareAccount>, CloudflareApiError, never> = Effect.fn(
	"CloudflareApi.listAccounts",
)(function* (accessToken: string, apiBaseUrl?: string) {
	const response = yield* runMapped(accessToken, Accounts.listAccounts({ perPage: 50 }), apiBaseUrl)
	yield* Effect.annotateCurrentSpan("maple.cloudflare.account_count", response.result.length)
	return response.result.map((account) => ({
		id: account.id,
		name: account.name,
		type: account.type,
	}))
})

export interface CloudflareZone {
	readonly id: string
	readonly name: string
	readonly status: string | null
}

// Zone discovery is bounded: the analytics poller reconciles state rows per zone, so a
// pathological account with thousands of zones must not fan out unbounded work.
const MAX_ZONES = 200

/**
 * List the account's active zones. Used by the analytics poller for zone discovery — each active
 * zone gets a poll-state row (and thus edge metrics under `cloudflare/{zoneName}`).
 */
export const listZones: (
	accessToken: string,
	accountId: string,
	apiBaseUrl?: string,
) => Effect.Effect<ReadonlyArray<CloudflareZone>, CloudflareApiError, never> = Effect.fn(
	"CloudflareApi.listZones",
)(function* (accessToken: string, accountId: string, apiBaseUrl?: string) {
	yield* Effect.annotateCurrentSpan("maple.cloudflare.account_id", accountId)
	const zones = yield* runMapped(
		accessToken,
		Zones.listZones
			.items({ account: { id: accountId }, status: "active", perPage: 50 })
			.pipe(Stream.take(MAX_ZONES), Stream.runCollect),
		apiBaseUrl,
	)
	yield* Effect.annotateCurrentSpan("maple.cloudflare.zone_count", zones.length)
	return zones.map((zone) => ({
		id: zone.id,
		name: zone.name,
		status: zone.status ?? null,
	}))
})

// ---------------------------------------------------------------------------
// GraphQL Analytics (the raw escape hatch the module doc-comment anticipates)
// ---------------------------------------------------------------------------
//
// The GraphQL Analytics API is not among distilled's generated services, but the SDK exports its
// operation factory, so we define the POST /graphql call as a first-class distilled operation:
// it then shares the credentials layer, retry policy (incl. Retry-After handling for the
// 300-queries-per-5-min limit), and error matching with every other call in this module.

const GraphqlRequest = Schema.Struct({
	query: Schema.String,
	variables: Schema.optional(Schema.Unknown),
}).pipe(T.Http({ method: "POST", path: "/graphql" }))

const GraphqlErrorItem = Schema.Struct({
	message: Schema.String,
	// GraphQL error extensions carry Cloudflare's machine-readable code (e.g. "authz" for
	// permission failures); path points at the offending selection. Both optional/loose —
	// callers branch on message + code, never on the full shape.
	extensions: Schema.optionalKey(Schema.Unknown),
	path: Schema.optionalKey(Schema.Unknown),
})

const GraphqlResponse = Schema.Struct({
	data: Schema.optionalKey(Schema.Unknown),
	errors: Schema.optionalKey(Schema.Union([Schema.Array(GraphqlErrorItem), Schema.Null])),
})

type GraphqlRequestShape = typeof GraphqlRequest.Type
type GraphqlResponseShape = typeof GraphqlResponse.Type

const graphqlOperation: API.OperationMethod<
	GraphqlRequestShape,
	GraphqlResponseShape,
	DefaultErrors,
	Credentials | HttpClient.HttpClient
> = API.make(() => ({
	input: GraphqlRequest,
	output: GraphqlResponse,
	errors: [],
}))

export interface CloudflareGraphqlError {
	readonly message: string
	readonly extensions?: unknown
	readonly path?: unknown
}

/**
 * A GraphQL execution result. Transport/auth failures surface as {@link CloudflareApiError};
 * GraphQL-level errors (HTTP 200 + `errors[]` — e.g. a dataset the plan doesn't include) are
 * returned for the caller to interpret, since only it knows whether an error means "disable this
 * dataset" or "reconnect the integration".
 */
export interface CloudflareGraphqlResult {
	readonly data: unknown
	readonly errors: ReadonlyArray<CloudflareGraphqlError>
}

/** Execute a GraphQL Analytics API query (`POST {apiBaseUrl}/graphql`). */
export const graphqlQuery: (
	accessToken: string,
	request: { readonly query: string; readonly variables?: Record<string, unknown> },
	apiBaseUrl?: string,
) => Effect.Effect<CloudflareGraphqlResult, CloudflareApiError, never> = Effect.fn(
	"CloudflareApi.graphqlQuery",
)(function* (
	accessToken: string,
	request: { readonly query: string; readonly variables?: Record<string, unknown> },
	apiBaseUrl?: string,
) {
	const response = yield* runMapped(
		accessToken,
		graphqlOperation({
			query: request.query,
			...(request.variables === undefined ? {} : { variables: request.variables }),
		}),
		apiBaseUrl,
	)
	const errors = response.errors ?? []
	yield* Effect.annotateCurrentSpan("maple.cloudflare.graphql_error_count", errors.length)
	return {
		data: response.data ?? null,
		errors,
	}
})

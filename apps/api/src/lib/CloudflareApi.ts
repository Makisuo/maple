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
import * as Accounts from "@distilled.cloud/cloudflare/accounts"
import { fromOAuth, type Credentials } from "@distilled.cloud/cloudflare/Credentials"
import { IntegrationsRevokedError, IntegrationsUpstreamError } from "@maple/domain/http"
import { Effect, Layer } from "effect"
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
export const listAccounts = (
	accessToken: string,
	apiBaseUrl?: string,
): Effect.Effect<ReadonlyArray<CloudflareAccount>, CloudflareApiError, never> =>
	runMapped(accessToken, Accounts.listAccounts({ perPage: 50 }), apiBaseUrl).pipe(
		Effect.map((response) =>
			response.result.map((account) => ({
				id: account.id,
				name: account.name,
				type: account.type,
			})),
		),
	)

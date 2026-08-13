import * as Context from "effect/Context"
import * as Clock from "effect/Clock"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import {
	MapleApiProtocolError,
	MapleApiRequestEncodingError,
	MapleApiResponseDecodeError,
	MapleApiResponseReadError,
	MapleApiTransportError,
	MapleErrorTags,
	MaplePublicErrorBodySchema,
	isMapleApiResponseError,
	makeMapleApiResponseError,
	type MapleApiResponseError,
	type MapleError,
	type MaplePublicErrorType,
} from "./errors"
import { MapleEnvironment } from "./MapleEnvironment"

/**
 * Thin JSON client for the Maple public v2 API.
 *
 * Providers call these instead of a generated client so the package ships
 * with zero runtime dependencies beyond `effect`. Responses are returned as
 * parsed JSON (`unknown`); each provider decodes just the fields it needs.
 *
 * Declared non-2xx responses retain the server's complete public error body.
 * Retry behavior comes from that body rather than being inferred from status.
 */
export interface MapleApiShape {
	readonly get: (path: string) => Effect.Effect<unknown, MapleError>
	readonly post: (path: string, body?: unknown) => Effect.Effect<unknown, MapleError>
	readonly patch: (path: string, body: unknown) => Effect.Effect<unknown, MapleError>
	readonly delete: (path: string) => Effect.Effect<unknown, MapleError>
}

export class MapleApi extends Context.Service<MapleApi, MapleApiShape>()("Maple::Api") {}

const ErrorEnvelope = Schema.Struct({ error: MaplePublicErrorBodySchema })
const decodeErrorEnvelope = Schema.decodeUnknownEffect(Schema.fromJsonString(ErrorEnvelope))
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))

const errorTypeForStatus = (status: number): MaplePublicErrorType | undefined => {
	switch (status) {
		case 400:
		case 413:
			return "invalid_request_error"
		case 401:
			return "authentication_error"
		case 403:
			return "permission_error"
		case 404:
			return "not_found_error"
		case 409:
			return "conflict_error"
		case 429:
			return "rate_limit_error"
		case 500:
		case 502:
		case 503:
		case 504:
			return "api_error"
		default:
			return undefined
	}
}

const notFoundTagForPath = (path: string): string | undefined => {
	const pathname = path.split("?", 1)[0] ?? path
	if (pathname.startsWith("/v2/api_keys/")) return MapleErrorTags.apiKeyNotFound
	if (pathname.startsWith("/v2/dashboards/")) return MapleErrorTags.dashboardNotFound
	if (pathname.startsWith("/v2/alerts/rules/") || pathname.startsWith("/v2/alerts/destinations/")) {
		return pathname.startsWith("/v2/alerts/rules/")
			? MapleErrorTags.alertRuleNotFound
			: MapleErrorTags.alertDestinationNotFound
	}
	return undefined
}

const errorFromResponse = Effect.fn("MapleApi.errorFromResponse")(function* (
	status: number,
	path: string,
	bodyText: string,
) {
	const envelope = yield* decodeErrorEnvelope(bodyText).pipe(
		Effect.mapError(
			() =>
				new MapleApiProtocolError({
					status,
					message: `Maple API returned an invalid error envelope with status ${status}`,
				}),
		),
	)
	const expectedType = errorTypeForStatus(status)
	if (expectedType === undefined || envelope.error.type !== expectedType) {
		return yield* new MapleApiProtocolError({
			status,
			message: `Maple API error type ${envelope.error.type} does not match status ${status}`,
		})
	}
	const expectedNotFoundTag = notFoundTagForPath(path)
	if (
		envelope.error.type === "not_found_error" &&
		expectedNotFoundTag !== undefined &&
		envelope.error._tag !== expectedNotFoundTag
	) {
		return yield* new MapleApiProtocolError({
			status,
			message: `Maple API returned ${envelope.error._tag} for ${path}; expected ${expectedNotFoundTag}`,
		})
	}
	return makeMapleApiResponseError(status, envelope.error)
})

const retryDelay = Effect.fn("MapleApi.retryDelay")(function* (
	error: MapleApiResponseError,
	attempt: number,
) {
	if (error.error.retry_after_seconds !== undefined) {
		return Duration.seconds(error.error.retry_after_seconds)
	}
	if (error.error.retry_at !== undefined) {
		const retryAt = Date.parse(error.error.retry_at)
		if (Number.isFinite(retryAt)) {
			const now = yield* Clock.currentTimeMillis
			return Duration.millis(Math.max(0, retryAt - now))
		}
	}
	return Duration.millis(Math.min(500 * 2 ** attempt, 10_000))
})

export const make = Effect.gen(function* () {
	const { baseUrl, apiKey } = yield* MapleEnvironment
	const httpClient = yield* HttpClient.HttpClient

	const request = (method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown) => {
		const canAutomaticallyRetry = method === "GET" || method === "DELETE"
		const execute: (attempt: number) => Effect.Effect<unknown, MapleError> = Effect.fn(
			"MapleApi.requestAttempt",
		)(function* (attempt: number) {
			return yield* Effect.gen(function* () {
				let req = HttpClientRequest.make(method)(`${baseUrl}${path}`).pipe(
					HttpClientRequest.setHeaders({
						Authorization: `Bearer ${Redacted.value(apiKey)}`,
						Accept: "application/json",
					}),
				)
				if (body !== undefined) {
					req = yield* HttpClientRequest.bodyJson(req, body).pipe(
						Effect.mapError(
							(error) =>
								new MapleApiRequestEncodingError({
									message: "Failed to encode Maple API request body",
									cause: error,
								}),
						),
					)
				}
				const response = yield* httpClient.execute(req).pipe(
					Effect.mapError(
						(error) =>
							new MapleApiTransportError({
								message: `Maple API request failed: ${error.message}`,
								cause: error,
							}),
					),
				)
				// Drain the body either way so the connection is released.
				const text = yield* response.text.pipe(
					Effect.mapError(
						(error) =>
							new MapleApiResponseReadError({
								status: response.status,
								message: `Failed to read response: ${error.message}`,
								cause: error,
							}),
					),
				)
				if (response.status >= 200 && response.status < 300) {
					if (text.length === 0) return undefined
					return yield* decodeJson(text).pipe(
						Effect.mapError(
							() =>
								new MapleApiResponseDecodeError({
									status: response.status,
									message: `Maple API returned invalid JSON (status ${response.status})`,
								}),
						),
					)
				}
				return yield* Effect.fail(yield* errorFromResponse(response.status, path, text))
			}).pipe(
				Effect.catchIf(isMapleApiResponseError, (error) =>
					canAutomaticallyRetry && error.error.retryable && attempt < 6
						? retryDelay(error, attempt).pipe(
								Effect.flatMap((delay) => Effect.sleep(delay)),
								Effect.andThen(execute(attempt + 1)),
							)
						: Effect.fail(error),
				),
			)
		})

		return execute(0)
	}

	return {
		get: (path: string) => request("GET", path),
		post: (path: string, body?: unknown) => request("POST", path, body),
		patch: (path: string, body: unknown) => request("PATCH", path, body),
		delete: (path: string) => request("DELETE", path),
	}
})

/**
 * Construct the Maple API client from caller-supplied {@link MapleEnvironment}
 * and {@link HttpClient.HttpClient} services.
 *
 * This is the open composition seam used by `providersWithDependencies()`.
 * Use {@link MapleApiLive} when the runtime's global `fetch` is the desired
 * transport.
 */
export const MapleApiFromHttpClient = () => Layer.effect(MapleApi, make)

/** Live client: caller-supplied {@link MapleEnvironment} + the runtime's global `fetch`. */
export const MapleApiLive = () => MapleApiFromHttpClient().pipe(Layer.provide(FetchHttpClient.layer))

/**
 * Fetch every page of a v2 list endpoint (`{ object: "list", data, has_more,
 * next_cursor }`), following cursors until exhausted.
 */
export const listAll = (
	api: MapleApiShape,
	path: string,
): Effect.Effect<ReadonlyArray<unknown>, MapleError> =>
	Effect.gen(function* () {
		const items: Array<unknown> = []
		let cursor: string | null = null
		do {
			const sep = path.includes("?") ? "&" : "?"
			const page = (yield* api.get(
				cursor === null
					? `${path}${sep}limit=100`
					: `${path}${sep}limit=100&cursor=${encodeURIComponent(cursor)}`,
			)) as { data?: ReadonlyArray<unknown>; has_more?: boolean; next_cursor?: string | null }
			items.push(...(page.data ?? []))
			cursor = page.has_more === true && typeof page.next_cursor === "string" ? page.next_cursor : null
		} while (cursor !== null)
		return items
	})

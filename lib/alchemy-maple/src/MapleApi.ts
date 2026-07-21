import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schedule from "effect/Schedule"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import {
	MapleApiError,
	MapleConflictError,
	MapleNotFoundError,
	MapleUnauthorizedError,
	type MapleError,
} from "./errors"
import { MapleEnvironment } from "./MapleEnvironment"

/**
 * Thin JSON client for the Maple public v2 API.
 *
 * Providers call these instead of a generated client so the package ships
 * with zero runtime dependencies beyond `effect`. Responses are returned as
 * parsed JSON (`unknown`); each provider decodes just the fields it needs.
 *
 * Known statuses map to typed errors (404 / 409 / 401·403); everything else
 * non-2xx is a {@link MapleApiError}. 429s and 5xx are retried with bounded
 * exponential backoff (the v2 API allows 600 requests per 60s per key).
 */
export interface MapleApiShape {
	readonly get: (path: string) => Effect.Effect<unknown, MapleError>
	readonly post: (path: string, body?: unknown) => Effect.Effect<unknown, MapleError>
	readonly patch: (path: string, body: unknown) => Effect.Effect<unknown, MapleError>
	readonly delete: (path: string) => Effect.Effect<unknown, MapleError>
}

export class MapleApi extends Context.Service<MapleApi, MapleApiShape>()("Maple::Api") {}

const errorFromResponse = (status: number, bodyText: string): MapleError => {
	let message = `Maple API request failed with status ${status}`
	let errorType: string | undefined
	let code: string | undefined
	try {
		const parsed = JSON.parse(bodyText) as { error?: { type?: string; code?: string; message?: string } }
		if (parsed?.error?.message) message = parsed.error.message
		errorType = parsed?.error?.type
		code = parsed?.error?.code
	} catch {
		if (bodyText.length > 0) message = `${message}: ${bodyText.slice(0, 200)}`
	}
	const fields = {
		status,
		message,
		...(errorType !== undefined ? { errorType } : {}),
		...(code !== undefined ? { code } : {}),
	}
	if (status === 404) return new MapleNotFoundError(fields)
	if (status === 409) return new MapleConflictError(fields)
	if (status === 401 || status === 403) return new MapleUnauthorizedError(fields)
	return new MapleApiError(fields)
}

const isRetryable = (error: MapleError): boolean =>
	error._tag === "Maple::ApiError" && (error.status === 429 || error.status >= 500)

const retryPolicy = Schedule.exponential(Duration.millis(500), 2).pipe(
	Schedule.either(Schedule.spaced(Duration.seconds(10))),
	Schedule.both(Schedule.recurs(6)),
)

export const make = Effect.gen(function* () {
	const { baseUrl, apiKey } = yield* MapleEnvironment
	const httpClient = yield* HttpClient.HttpClient

	const request = (method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown) =>
		Effect.gen(function* () {
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
							new MapleApiError({
								status: 0,
								message: `Failed to encode request body: ${String(error)}`,
							}),
					),
				)
			}
			const response = yield* httpClient.execute(req).pipe(
				Effect.mapError(
					(error) => new MapleApiError({ status: 0, message: `Maple API request failed: ${error.message}` }),
				),
			)
			// Drain the body either way so the connection is released.
			const text = yield* response.text.pipe(
				Effect.mapError(
					(error) =>
						new MapleApiError({ status: response.status, message: `Failed to read response: ${error.message}` }),
				),
			)
			if (response.status >= 200 && response.status < 300) {
				if (text.length === 0) return undefined as unknown
				return yield* Effect.try({
					try: () => JSON.parse(text) as unknown,
					catch: () =>
						new MapleApiError({
							status: response.status,
							message: `Maple API returned invalid JSON (status ${response.status})`,
						}),
				})
			}
			return yield* Effect.fail(errorFromResponse(response.status, text))
		}).pipe(
			Effect.retry({
				schedule: retryPolicy,
				while: isRetryable,
			}),
		)

	return {
		get: (path: string) => request("GET", path),
		post: (path: string, body?: unknown) => request("POST", path, body),
		patch: (path: string, body: unknown) => request("PATCH", path, body),
		delete: (path: string) => request("DELETE", path),
	}
})

/** Live client: {@link MapleEnvironment} + the runtime's global `fetch`. */
export const MapleApiLive = () =>
	Layer.effect(MapleApi, make).pipe(Layer.provide(FetchHttpClient.layer))

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
				cursor === null ? `${path}${sep}limit=100` : `${path}${sep}limit=100&cursor=${encodeURIComponent(cursor)}`,
			)) as { data?: ReadonlyArray<unknown>; has_more?: boolean; next_cursor?: string | null }
			items.push(...(page.data ?? []))
			cursor = page.has_more === true && typeof page.next_cursor === "string" ? page.next_cursor : null
		} while (cursor !== null)
		return items
	})

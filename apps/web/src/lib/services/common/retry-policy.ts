import { Effect, Schedule } from "effect"
import {
	HttpClient,
	HttpClientError,
	type HttpClientRequest,
	type HttpClientResponse,
} from "effect/unstable/http"

const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

export const isIdempotentRequest = (request: HttpClientRequest.HttpClientRequest): boolean =>
	IDEMPOTENT_METHODS.has(request.method.toUpperCase())

/**
 * Transient network failure worth replaying: a `TransportError` (fetch failed,
 * DNS, connection reset) on an idempotent request. Transport failures can occur
 * after the request reached the server, so mutations are never replayed. The
 * 45s client timeout (`AbortSignal.timeout` in http-client.ts) also surfaces as
 * a TransportError — excluded so one hang doesn't multiply into several.
 */
export const isRetryableTransportError = (error: unknown): boolean => {
	if (!HttpClientError.isHttpClientError(error)) return false
	if (error.reason._tag !== "TransportError") return false
	const cause = error.reason.cause
	if (cause instanceof DOMException && (cause.name === "TimeoutError" || cause.name === "AbortError")) {
		return false
	}
	return isIdempotentRequest(error.request)
}

/**
 * Retry only the short server-failure set that commonly self-heals. A 504 is
 * usually a query-budget timeout and an identical replay just multiplies work;
 * 408/429 need user-visible pacing rather than a hidden retry burst.
 */
export const isRetryableResponse = (response: HttpClientResponse.HttpClientResponse): boolean =>
	isIdempotentRequest(response.request) &&
	(response.status === 500 || response.status === 502 || response.status === 503)

/** Backoff between HTTP-layer retry attempts: 300ms → 600ms → 1.2s. */
export const mapleRetrySchedule = Schedule.exponential("300 millis")

interface MapleRetryPolicyOptions {
	/** Return true after performing any stale-credential invalidation required for this request. */
	readonly retryUnauthorized?: (request: HttpClientRequest.HttpClientRequest) => boolean
}

/**
 * Response-aware retry for raw Effect HTTP clients.
 *
 * `HttpClient.retry` only observes failed Effects, while HttpApi decoding turns
 * non-2xx responses into typed errors *after* the raw client transform. Handle
 * transient response statuses here, before decoding, and retain error retries
 * for genuine fetch/DNS failures. Mutations are never replayed.
 */
export const withMapleRetryPolicy = <E, R>(
	client: HttpClient.HttpClient.With<E, R>,
	options: MapleRetryPolicyOptions = {},
): HttpClient.HttpClient.With<E, R> =>
	HttpClient.transform(client, (requestEffect, request) => {
		if (!isIdempotentRequest(request)) return requestEffect
		const retryResponses = Effect.repeat(requestEffect, {
			times: 3,
			schedule: Schedule.passthrough(mapleRetrySchedule),
			while: (response) =>
				isRetryableResponse(response) ||
				(response.status === 401 && (options.retryUnauthorized?.(request) ?? false)),
		})
		return Effect.retry(retryResponses, {
			times: 3,
			schedule: mapleRetrySchedule,
			while: isRetryableTransportError,
		})
	})

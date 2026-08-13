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

/** Retry transport failures only for idempotent requests, excluding client timeouts. */
export const isRetryableTransportError = (error: unknown): boolean => {
	if (!HttpClientError.isHttpClientError(error)) return false
	if (error.reason._tag !== "TransportError") return false
	const cause = error.reason.cause
	if (cause instanceof DOMException && (cause.name === "TimeoutError" || cause.name === "AbortError")) {
		return false
	}
	return isIdempotentRequest(error.request)
}

const isV2Request = (request: HttpClientRequest.HttpClientRequest): boolean => {
	try {
		return new URL(request.url).pathname.startsWith("/v2/")
	} catch {
		return false
	}
}

// v2 retryability lives in the decoded public error body. This transport layer
// cannot consume that body without stealing it from HttpApi decoding, so it
// never infers v2 retry behavior from status. Legacy response behavior remains
// unchanged until v1 is migrated separately.
export const isRetryableResponse = (response: HttpClientResponse.HttpClientResponse): boolean =>
	isIdempotentRequest(response.request) &&
	!isV2Request(response.request) &&
	(response.status === 500 || response.status === 502 || response.status === 503)

export const mapleRetrySchedule = Schedule.exponential("300 millis")

interface MapleRetryPolicyOptions {
	readonly retryUnauthorized?: (request: HttpClientRequest.HttpClientRequest) => boolean
}

// Non-2xx responses are still successes here; retry them before HttpApi decoding.
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

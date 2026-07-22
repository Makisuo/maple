import { Schedule } from "effect"
import { HttpClientError } from "effect/unstable/http"

const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

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
	return IDEMPOTENT_METHODS.has(error.request.method.toUpperCase())
}

/** Backoff between HTTP-layer retry attempts: 300ms → 600ms → 1.2s. */
export const mapleRetrySchedule = Schedule.exponential("300 millis")

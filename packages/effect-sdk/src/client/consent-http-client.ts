import { consentAllowedSince, hasConsent } from "@maple/browser-session"
import { Effect, Layer } from "effect"

import { trySyncOrUndefined } from "../shared/try-sync.js"
import {
	FetchHttpClient,
	HttpBody,
	HttpClient,
	HttpClientRequest,
	HttpClientResponse,
} from "effect/unstable/http"

/**
 * Only timestamps are modeled; all other OTLP fields pass through via spreads.
 */
interface OtlpSpan {
	readonly startTimeUnixNano?: unknown
}
interface OtlpLogRecord {
	readonly timeUnixNano?: unknown
	readonly observedTimeUnixNano?: unknown
}
interface OtlpScopeSpans {
	readonly spans?: ReadonlyArray<OtlpSpan>
}
interface OtlpScopeLogs {
	readonly logRecords?: ReadonlyArray<OtlpLogRecord>
}
interface OtlpResourceSpans {
	readonly scopeSpans?: ReadonlyArray<OtlpScopeSpans>
}
interface OtlpResourceLogs {
	readonly scopeLogs?: ReadonlyArray<OtlpScopeLogs>
}
interface OtlpBody {
	readonly resourceSpans?: ReadonlyArray<OtlpResourceSpans>
	readonly resourceLogs?: ReadonlyArray<OtlpResourceLogs>
}

// A nanosecond timestamp that is not a numeric string throws out of `BigInt`
// rather than producing NaN, and an event with no readable timestamp cannot be
// shown to postdate consent — so it is dropped.
const after = (value: unknown, threshold: bigint): boolean =>
	trySyncOrUndefined(() => BigInt(String(value ?? 0)) >= threshold) ?? false

const pruneTraces = (body: OtlpBody, threshold: bigint): OtlpBody | undefined => {
	const resourceSpans = (body.resourceSpans ?? [])
		.map((resource) => ({
			...resource,
			scopeSpans: (resource.scopeSpans ?? [])
				.map((scope) => ({
					...scope,
					spans: (scope.spans ?? []).filter((span) => after(span.startTimeUnixNano, threshold)),
				}))
				.filter((scope) => scope.spans.length > 0),
		}))
		.filter((resource) => resource.scopeSpans.length > 0)
	return resourceSpans.length > 0 ? { ...body, resourceSpans } : undefined
}

const pruneLogs = (body: OtlpBody, threshold: bigint): OtlpBody | undefined => {
	const resourceLogs = (body.resourceLogs ?? [])
		.map((resource) => ({
			...resource,
			scopeLogs: (resource.scopeLogs ?? [])
				.map((scope) => ({
					...scope,
					logRecords: (scope.logRecords ?? []).filter((record) =>
						after(record.timeUnixNano ?? record.observedTimeUnixNano, threshold),
					),
				}))
				.filter((scope) => scope.logRecords.length > 0),
		}))
		.filter((resource) => resource.scopeLogs.length > 0)
	return resourceLogs.length > 0 ? { ...body, resourceLogs } : undefined
}

/**
 * Keeps signals captured under the current grant. Cumulative Effect metrics
 * cannot be separated here, so explicit-consent installs suppress them.
 */
export const filterOtlpRequestForConsent = (
	request: HttpClientRequest.HttpClientRequest,
	requireConsent: boolean,
): HttpClientRequest.HttpClientRequest | undefined => {
	if (!hasConsent()) return undefined
	if (!requireConsent) return request
	if (request.url.endsWith("/v1/metrics")) return undefined
	if (request.body._tag !== "Uint8Array") return undefined
	// Bound before the closure: narrowing on `request.body` does not survive into one.
	const body = request.body

	const since = consentAllowedSince()
	if (!Number.isFinite(since)) return undefined
	// Unknown payloads must fail closed on an explicit-consent install: an
	// undecodable body, or a `since` past the BigInt range, drops the request
	// rather than forwarding it unfiltered.
	return trySyncOrUndefined(() => {
		// SAFETY: The SDK's OTLP encoder created this body; malformed shapes throw here and fail closed.
		const decoded = JSON.parse(new TextDecoder().decode(body.body)) as OtlpBody
		const threshold = BigInt(Math.trunc(since)) * 1_000_000n
		const filtered = request.url.endsWith("/v1/traces")
			? pruneTraces(decoded, threshold)
			: request.url.endsWith("/v1/logs")
				? pruneLogs(decoded, threshold)
				: undefined
		return filtered
			? HttpClientRequest.setBody(request, HttpBody.jsonUnsafe(filtered, body.contentType))
			: undefined
	})
}

export const consentHttpClientLayer = (requireConsent: boolean) =>
	Layer.effect(
		HttpClient.HttpClient,
		Effect.map(HttpClient.HttpClient, (inner) =>
			HttpClient.make((request) => {
				const filtered = filterOtlpRequestForConsent(request, requireConsent)
				return filtered
					? inner.execute(filtered)
					: Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 200 })))
			}),
		),
	).pipe(Layer.provide(FetchHttpClient.layer))

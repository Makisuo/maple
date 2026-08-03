import { consentAllowedSince, hasConsent } from "@maple/browser-session"
import { Effect, Layer } from "effect"
import {
	FetchHttpClient,
	HttpBody,
	HttpClient,
	HttpClientRequest,
	HttpClientResponse,
} from "effect/unstable/http"

type JsonObject = Record<string, any>

const after = (value: unknown, threshold: bigint): boolean => {
	try {
		return BigInt(String(value ?? 0)) >= threshold
	} catch {
		return false
	}
}

const pruneTraces = (body: JsonObject, threshold: bigint): JsonObject | undefined => {
	const resourceSpans = (body.resourceSpans ?? [])
		.map((resource: JsonObject) => ({
			...resource,
			scopeSpans: (resource.scopeSpans ?? [])
				.map((scope: JsonObject) => ({
					...scope,
					spans: (scope.spans ?? []).filter((span: JsonObject) =>
						after(span.startTimeUnixNano, threshold),
					),
				}))
				.filter((scope: JsonObject) => scope.spans.length > 0),
		}))
		.filter((resource: JsonObject) => resource.scopeSpans.length > 0)
	return resourceSpans.length > 0 ? { ...body, resourceSpans } : undefined
}

const pruneLogs = (body: JsonObject, threshold: bigint): JsonObject | undefined => {
	const resourceLogs = (body.resourceLogs ?? [])
		.map((resource: JsonObject) => ({
			...resource,
			scopeLogs: (resource.scopeLogs ?? [])
				.map((scope: JsonObject) => ({
					...scope,
					logRecords: (scope.logRecords ?? []).filter((record: JsonObject) =>
						after(record.timeUnixNano ?? record.observedTimeUnixNano, threshold),
					),
				}))
				.filter((scope: JsonObject) => scope.logRecords.length > 0),
		}))
		.filter((resource: JsonObject) => resource.scopeLogs.length > 0)
	return resourceLogs.length > 0 ? { ...body, resourceLogs } : undefined
}

/**
 * Keep only signals captured under the current consent grant. Effect metrics
 * are cumulative and cannot be separated at this HTTP boundary, so the
 * built-in OTLP preset suppresses them when explicit consent gating is used;
 * MapleFlush uses its gated registry and can export post-grant metrics safely.
 */
export const filterOtlpRequestForConsent = (
	request: HttpClientRequest.HttpClientRequest,
	requireConsent: boolean,
): HttpClientRequest.HttpClientRequest | undefined => {
	if (!hasConsent()) return undefined
	if (!requireConsent) return request
	if (request.url.endsWith("/v1/metrics")) return undefined
	if (request.body._tag !== "Uint8Array") return undefined

	const since = consentAllowedSince()
	if (!Number.isFinite(since)) return undefined
	try {
		const decoded = JSON.parse(new TextDecoder().decode(request.body.body)) as JsonObject
		const threshold = BigInt(Math.trunc(since)) * 1_000_000n
		const filtered = request.url.endsWith("/v1/traces")
			? pruneTraces(decoded, threshold)
			: request.url.endsWith("/v1/logs")
				? pruneLogs(decoded, threshold)
				: undefined
		return filtered
			? HttpClientRequest.setBody(request, HttpBody.jsonUnsafe(filtered, request.body.contentType))
			: undefined
	} catch {
		// Unknown payloads must fail closed on an explicit-consent install.
		return undefined
	}
}

/** HTTP client used only by Effect's OTLP exporters. */
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

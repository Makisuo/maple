// ---------------------------------------------------------------------------
// MapleCloudflareSDK — Cloudflare Workers OTLP telemetry
//
// Constructible at module scope (no env required); resolves env lazily on
// first `flush(env)`. The Tracer + Effect Logger push into in-isolate buffers;
// flush drains them to the OTLP collector via plain `fetch`.
//
// Typical wiring:
//
//   import * as MapleCloudflareSDK from "@maple-dev/effect-sdk/cloudflare"
//   const telemetry = MapleCloudflareSDK.make({ serviceName: "my-worker" })
//
//   const handler = HttpRouter.toWebHandler(
//     Routes.pipe(Layer.provideMerge(telemetry.layer)),
//   )
//
//   export default {
//     async fetch(req, env, ctx) {
//       const res = await handler(req)
//       ctx.waitUntil(telemetry.flush(env))
//       return res
//     },
//   }
//
// Errors during flush are swallowed and logged to `console.error`. After a
// failure the exporter sleeps for 60 seconds (per signal) before retrying so
// a broken collector doesn't get hammered.
// ---------------------------------------------------------------------------

import { Layer, Redacted } from "effect"
import {
	type ResolvedResource,
	resolveResourceFromEnv,
} from "../server/resource.js"
import { type LogBuffer, type LogRecord, makeLogBuffer } from "./flushable-logger.js"
import { makeSpanBuffer, type OtlpSpan, type SpanBuffer } from "./flushable-tracer.js"

export interface Config {
	/**
	 * Service name reported in traces and logs. Defaults to `env.OTEL_SERVICE_NAME`,
	 * then `"unknown"`.
	 */
	readonly serviceName?: string | undefined
	readonly serviceVersion?: string | undefined
	readonly environment?: string | undefined
	/**
	 * Ingest endpoint URL (base, no path). Defaults to `env.MAPLE_ENDPOINT`,
	 * then `env.OTEL_EXPORTER_OTLP_ENDPOINT`. When unset, the SDK runs in
	 * no-op mode (spans/logs dropped, flush returns immediately).
	 */
	readonly endpoint?: string | undefined
	/** Maple ingest key. Defaults to `env.MAPLE_INGEST_KEY`. */
	readonly ingestKey?: string | undefined
	readonly attributes?: Record<string, unknown> | undefined
	/** Skip Effect log spans in OTLP log attributes. Default `false`. */
	readonly excludeLogSpans?: boolean | undefined
	/** OTLP traces path appended to `endpoint`. Default `/v1/traces`. */
	readonly tracesPath?: string | undefined
	/** OTLP logs path appended to `endpoint`. Default `/v1/logs`. */
	readonly logsPath?: string | undefined
}

export interface Telemetry {
	/**
	 * Effect Layer that installs the OTLP tracer + Effect logger. Stable across
	 * the isolate's lifetime. Provide it to whichever runtime actually runs
	 * your routes (e.g. include it in the Layer composition handed to
	 * `HttpRouter.toWebHandler`, NOT a separate per-request runtime — the
	 * Tracer reference must be in the same runtime as your handler code).
	 */
	readonly layer: Layer.Layer<never>
	/**
	 * Drain in-isolate buffers to the OTLP collector. Call inside
	 * `ctx.waitUntil(telemetry.flush(env))` after sending the response.
	 *
	 * - Lazy env resolution on first call.
	 * - No-op when no endpoint configured (and disables future buffering).
	 * - Errors are caught and logged to `console.error`; cooldown of 60s
	 *   per signal before next attempt after a failure.
	 */
	flush(env: Record<string, unknown>): Promise<void>
}

const COOLDOWN_MS = 60_000

interface Resolved {
	readonly tracesUrl: string
	readonly logsUrl: string
	readonly resource: OtlpResourceLike
	readonly scope: { readonly name: string }
	readonly headers: Record<string, string>
}

interface OtlpResourceLike {
	readonly attributes: ReadonlyArray<{ readonly key: string; readonly value: unknown }>
	readonly droppedAttributesCount: number
}

const resolveOnce = (env: Record<string, unknown>, config: Config): Resolved | null => {
	const r: ResolvedResource = resolveResourceFromEnv(env, { ...config, sdkType: "cloudflare" })
	if (!r.endpoint) return null
	const baseUrl = r.endpoint.endsWith("/") ? r.endpoint.slice(0, -1) : r.endpoint
	const tracesUrl = `${baseUrl}${config.tracesPath ?? "/v1/traces"}`
	const logsUrl = `${baseUrl}${config.logsPath ?? "/v1/logs"}`
	const headers: Record<string, string> = {
		"content-type": "application/json",
		"user-agent": "maple-effect-sdk-cloudflare/0.0.0",
	}
	if (r.ingestKey) headers.authorization = `Bearer ${Redacted.value(r.ingestKey)}`
	const otelResource = makeOtlpResource(r.resource)
	return { tracesUrl, logsUrl, resource: otelResource, scope: { name: r.resource.serviceName }, headers }
}

const makeOtlpResource = (resource: {
	readonly serviceName: string
	readonly serviceVersion: string | undefined
	readonly attributes: Record<string, unknown>
}): OtlpResourceLike => {
	const attrs: Array<{ readonly key: string; readonly value: unknown }> = []
	for (const [key, value] of Object.entries(resource.attributes)) {
		attrs.push({ key, value: anyValue(value) })
	}
	attrs.push({ key: "service.name", value: { stringValue: resource.serviceName } })
	if (resource.serviceVersion) {
		attrs.push({ key: "service.version", value: { stringValue: resource.serviceVersion } })
	}
	return { attributes: attrs, droppedAttributesCount: 0 }
}

const anyValue = (value: unknown): unknown => {
	if (Array.isArray(value)) return { arrayValue: { values: value.map(anyValue) } }
	switch (typeof value) {
		case "string":
			return { stringValue: value }
		case "boolean":
			return { boolValue: value }
		case "number":
			return Number.isInteger(value) ? { intValue: value } : { doubleValue: value }
		case "bigint":
			return { intValue: Number(value) }
		default:
			return { stringValue: String(value) }
	}
}

interface SignalState {
	disabledUntil: number
}

const post = async (url: string, headers: Record<string, string>, body: unknown): Promise<void> => {
	const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) })
	if (!res.ok) {
		throw new Error(`OTLP ${res.status} ${res.statusText}`)
	}
}

const flushSignal = async <T>(
	url: string,
	headers: Record<string, string>,
	body: () => unknown,
	state: SignalState,
	count: number,
	signal: string,
): Promise<void> => {
	if (count === 0) return
	if (state.disabledUntil && Date.now() < state.disabledUntil) return
	state.disabledUntil = 0
	try {
		await post(url, headers, body())
	} catch (err) {
		state.disabledUntil = Date.now() + COOLDOWN_MS
		console.error(`[MapleCloudflareSDK] ${signal} flush failed; cooldown 60s:`, err)
	}
}

export const make = (config: Config = {}): Telemetry => {
	const spans: SpanBuffer = makeSpanBuffer()
	const logs: LogBuffer = makeLogBuffer({ excludeLogSpans: config.excludeLogSpans })

	let resolved: Resolved | null | undefined = undefined
	const tracesState: SignalState = { disabledUntil: 0 }
	const logsState: SignalState = { disabledUntil: 0 }

	const layer = Layer.mergeAll(spans.tracerLayer, logs.loggerLayer)

	const flush = async (env: Record<string, unknown>): Promise<void> => {
		if (resolved === undefined) {
			resolved = resolveOnce(env, config)
			if (resolved === null) {
				spans.setDisabled(true)
				logs.setDisabled(true)
				return
			}
		}
		if (resolved === null) return

		const r = resolved
		const spanBatch = spans.drain()
		const logBatch = logs.drain()

		await Promise.all([
			flushSignal(
				r.tracesUrl,
				r.headers,
				() => makeTracesBody(spanBatch, r),
				tracesState,
				spanBatch.length,
				"traces",
			),
			flushSignal(
				r.logsUrl,
				r.headers,
				() => makeLogsBody(logBatch, r),
				logsState,
				logBatch.length,
				"logs",
			),
		])
	}

	return { layer, flush }
}

const makeTracesBody = (spans: ReadonlyArray<OtlpSpan>, r: Resolved) => ({
	resourceSpans: [{ resource: r.resource, scopeSpans: [{ scope: r.scope, spans }] }],
})

const makeLogsBody = (logs: ReadonlyArray<LogRecord>, r: Resolved) => ({
	resourceLogs: [{ resource: r.resource, scopeLogs: [{ scope: r.scope, logRecords: logs }] }],
})

// ---------------------------------------------------------------------------
// Convenience namespace export so call sites read as
// `MapleCloudflareSDK.make({...})` when imported as a default.
// ---------------------------------------------------------------------------
export const MapleCloudflareSDK = { make }

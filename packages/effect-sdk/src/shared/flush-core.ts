// BOUNDARY: This module owns unparsed external values and narrows them before domain use.
// Shared flush core (platform-agnostic)
//
// The buffer-drain → OTLP-encode → POST machinery shared by every flushable
// preset (Cloudflare, server, client). Each preset owns only its config
// resolution (env-lazy on Workers, env-auto-detect on Node, programmatic in the
// browser) and its transport (plain `fetch` vs `fetch(keepalive)`); everything
// downstream of a resolved endpoint lives here.
import { Redacted } from "effect"
import type { LogBuffer, LogRecord } from "./flushable-logger.js"
import type { MetricBuffer } from "./flushable-metrics.js"
import type { OtlpSpan, SpanBuffer } from "./flushable-tracer.js"

/** Disable a signal for this long after a failed POST so a broken collector isn't hammered. */
const COOLDOWN_MS = 60_000

/**
 * Minimal resource shape consumed by {@link buildResolved}. Structurally
 * satisfied by `ResolvedResource` from `server/resource.ts` (server +
 * Cloudflare) and by the object the browser client builds inline — so this
 * module never has to import the env-reading server resolver, keeping the
 * client bundle free of `process.env`.
 */
export interface ResourceInput {
	readonly endpoint: string | undefined
	readonly ingestKey: Redacted.Redacted<string> | undefined
	readonly resource: {
		readonly serviceName: string
		readonly serviceVersion: string | undefined
		readonly attributes: Record<string, unknown>
	}
}

/** Fully resolved, ready-to-POST OTLP context for one isolate/process. */
export interface Resolved {
	readonly tracesUrl: string
	readonly logsUrl: string
	readonly metricsUrl: string
	readonly resource: OtlpResourceLike
	readonly scope: { readonly name: string }
	readonly headers: Record<string, string>
	readonly noOp: boolean
}

interface OtlpResourceLike {
	readonly attributes: ReadonlyArray<{ readonly key: string; readonly value: unknown }>
	readonly droppedAttributesCount: number
}

/** Per-signal cooldown bookkeeping (mutated in place by {@link flushSignal}). */
export interface SignalState {
	disabledUntil: number
}

/**
 * How a preset delivers an encoded OTLP body. The default {@link fetchTransport}
 * is a plain POST; the browser client swaps in a `keepalive` POST so flushes on
 * `pagehide` survive the unload.
 */
export interface FlushTransport {
	readonly post: (url: string, headers: Record<string, string>, body: unknown) => Promise<void>
}

/**
 * Turn a resolved resource into ready-to-POST URLs + headers. Shared by all
 * presets; `userAgent` is the only per-preset difference.
 */
export const buildResolved = (
	r: ResourceInput,
	opts: {
		readonly tracesPath?: string | undefined
		readonly logsPath?: string | undefined
		readonly metricsPath?: string | undefined
		readonly userAgent: string
	},
): Resolved => {
	// `r.endpoint` is always defined in practice (every resolver falls back to
	// DEFAULT_MAPLE_ENDPOINT, and the client requires it); guard anyway.
	const base = r.endpoint ?? "https://ingest.maple.dev"
	const baseUrl = base.endsWith("/") ? base.slice(0, -1) : base
	const tracesUrl = `${baseUrl}${opts.tracesPath ?? "/v1/traces"}`
	const logsUrl = `${baseUrl}${opts.logsPath ?? "/v1/logs"}`
	const metricsUrl = `${baseUrl}${opts.metricsPath ?? "/v1/metrics"}`
	const headers: Record<string, string> = {
		"content-type": "application/json",
		"user-agent": opts.userAgent,
	} satisfies Record<string, string>
	if (r.ingestKey) headers.authorization = `Bearer ${Redacted.value(r.ingestKey)}`
	return {
		tracesUrl,
		logsUrl,
		metricsUrl,
		resource: makeOtlpResource(r.resource),
		scope: { name: r.resource.serviceName },
		headers,
		noOp: r.ingestKey === undefined,
	}
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

/** Plain `fetch` POST. Throws on non-2xx so {@link flushSignal} records a cooldown. */
const post = async (url: string, headers: Record<string, string>, body: unknown): Promise<void> => {
	const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) })
	if (!res.ok) {
		throw new Error(`OTLP ${res.status} ${res.statusText}`)
	}
}

/** Default transport: plain `fetch` (server + Cloudflare). */
export const fetchTransport: FlushTransport = { post }

const flushSignal = async <A>(args: {
	readonly url: string
	readonly headers: Record<string, string>
	readonly buffer: { readonly drain: () => Array<A>; readonly restore: (items: ReadonlyArray<A>) => void }
	readonly body: (items: ReadonlyArray<A>) => unknown
	readonly state: SignalState
	readonly signal: string
	readonly transport: FlushTransport
	readonly logPrefix: string
}): Promise<void> => {
	const { url, headers, buffer, body, state, signal, transport, logPrefix } = args
	if (state.disabledUntil && Date.now() < state.disabledUntil) {
		console.warn(
			`${logPrefix} ${signal} flush skipped (cooldown ${state.disabledUntil - Date.now()}ms remaining)`,
		)
		return
	}
	state.disabledUntil = 0
	const batch = buffer.drain()
	if (batch.length === 0) return
	try {
		await transport.post(url, headers, body(batch))
	} catch (err) {
		buffer.restore(batch)
		state.disabledUntil = Date.now() + COOLDOWN_MS
		console.error(`${logPrefix} ${signal} flush failed; cooldown 60s:`, err)
	}
}

/** Serialize flush calls so concurrent timers/manual hooks cannot drain overlapping batches. */
export const makeSerializedFlush = <Args extends ReadonlyArray<unknown>>(
	run: (...args: Args) => Promise<void>,
): ((...args: Args) => Promise<void>) => {
	let tail: Promise<void> = Promise.resolve()
	return (...args) => {
		const next = tail.then(
			() => run(...args),
			() => run(...args),
		)
		tail = next.catch(() => undefined)
		return next
	}
}

/**
 * Drain the span + log buffers and POST them. Errors are swallowed per signal
 * (see {@link flushSignal}); the returned promise never rejects.
 *
 * - `noOp`: drain so the buffers don't grow unbounded, fire `onNoOp` (one-shot
 *   "telemetry disabled" notice), never POST.
 * - empty buffers: short-circuit without a request.
 */
export const runFlush = async (args: {
	readonly resolved: Resolved
	readonly spans: SpanBuffer
	readonly logs: LogBuffer
	readonly metrics: MetricBuffer
	readonly tracesState: SignalState
	readonly logsState: SignalState
	readonly metricsState: SignalState
	readonly transport: FlushTransport
	readonly logPrefix: string
	readonly onNoOp: () => void
}): Promise<void> => {
	const {
		resolved: r,
		spans,
		logs,
		metrics,
		tracesState,
		logsState,
		metricsState,
		transport,
		logPrefix,
		onNoOp,
	} = args

	if (r.noOp) {
		spans.drain()
		logs.drain()
		metrics.drain()
		onNoOp()
		return
	}

	await Promise.all([
		flushSignal({
			url: r.tracesUrl,
			headers: r.headers,
			buffer: spans,
			body: (items) => makeTracesBody(items, r),
			state: tracesState,
			signal: "traces",
			transport,
			logPrefix,
		}),
		flushSignal({
			url: r.logsUrl,
			headers: r.headers,
			buffer: logs,
			body: (items) => makeLogsBody(items, r),
			state: logsState,
			signal: "logs",
			transport,
			logPrefix,
		}),
		flushSignal({
			url: r.metricsUrl,
			headers: r.headers,
			buffer: metrics,
			body: (items) => makeMetricsBody(items, r),
			state: metricsState,
			signal: "metrics",
			transport,
			logPrefix,
		}),
	])
}

const makeTracesBody = (spans: ReadonlyArray<OtlpSpan>, r: Resolved) => ({
	resourceSpans: [{ resource: r.resource, scopeSpans: [{ scope: r.scope, spans }] }],
})

const makeLogsBody = (logs: ReadonlyArray<LogRecord>, r: Resolved) => ({
	resourceLogs: [{ resource: r.resource, scopeLogs: [{ scope: r.scope, logRecords: logs }] }],
})

type MetricSnapshot = ReturnType<MetricBuffer["drain"]>[number]

const metricAttributes = (
	attributes: Readonly<Record<string, string>> | undefined,
	extra?: readonly [string, string],
) => [
	...Object.entries(attributes ?? {}).map(([key, value]) => ({
		key,
		value: anyValue(value),
	})),
	...(extra ? [{ key: extra[0], value: anyValue(extra[1]) }] : []),
]

const makeMetricsBody = (snapshots: ReadonlyArray<MetricSnapshot>, r: Resolved) => {
	const timestamp = (BigInt(Date.now()) * 1_000_000n).toString()
	const metrics: Array<Record<string, unknown>> = []

	for (const snapshot of snapshots) {
		const base = {
			name: snapshot.id,
			...(snapshot.description ? { description: snapshot.description } : undefined),
		}
		switch (snapshot.type) {
			case "Counter":
				metrics.push({
					...base,
					sum: {
						aggregationTemporality: 2,
						isMonotonic: snapshot.state.incremental,
						dataPoints: [
							{
								attributes: metricAttributes(snapshot.attributes),
								timeUnixNano: timestamp,
								asDouble: Number(snapshot.state.count),
							},
						],
					},
				})
				break
			case "Gauge":
				metrics.push({
					...base,
					gauge: {
						dataPoints: [
							{
								attributes: metricAttributes(snapshot.attributes),
								timeUnixNano: timestamp,
								asDouble: Number(snapshot.state.value),
							},
						],
					},
				})
				break
			case "Frequency":
				metrics.push({
					...base,
					sum: {
						aggregationTemporality: 2,
						isMonotonic: true,
						dataPoints: [...snapshot.state.occurrences].map(([value, count]) => ({
							attributes: metricAttributes(snapshot.attributes, ["value", value]),
							timeUnixNano: timestamp,
							asDouble: count,
						})),
					},
				})
				break
			case "Histogram": {
				let previous = 0
				const finiteBuckets = snapshot.state.buckets.filter(([bound]) => Number.isFinite(bound))
				const bucketCounts = finiteBuckets.map(([, cumulative]) => {
					const count = cumulative - previous
					previous = cumulative
					return String(count)
				})
				bucketCounts.push(String(snapshot.state.count - previous))
				metrics.push({
					...base,
					histogram: {
						aggregationTemporality: 2,
						dataPoints: [
							{
								attributes: metricAttributes(snapshot.attributes),
								timeUnixNano: timestamp,
								count: String(snapshot.state.count),
								sum: snapshot.state.sum,
								min: snapshot.state.min,
								max: snapshot.state.max,
								explicitBounds: finiteBuckets.map(([bound]) => bound),
								bucketCounts,
							},
						],
					},
				})
				break
			}
			case "Summary":
				metrics.push({
					...base,
					summary: {
						dataPoints: [
							{
								attributes: metricAttributes(snapshot.attributes),
								timeUnixNano: timestamp,
								count: String(snapshot.state.count),
								sum: snapshot.state.sum,
								quantileValues: snapshot.state.quantiles.flatMap(([quantile, value]) =>
									value === undefined ? [] : [{ quantile, value }],
								),
							},
						],
					},
				})
				break
		}
	}

	return {
		resourceMetrics: [
			{
				resource: r.resource,
				scopeMetrics: [{ scope: r.scope, metrics }],
			},
		],
	}
}

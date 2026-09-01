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
//
// The buffer-drain → encode → POST machinery is shared with the server/client
// flushable presets via `../shared/flush-core.ts`; this module owns only the
// Cloudflare-specific lazy `env` resolution.

import { Layer } from "effect"
import {
	buildResolved,
	fetchTransport,
	guardFlush,
	makeSerializedFlush,
	type Resolved,
	runFlush,
	type SignalState,
} from "../shared/flush-core.js"
import { type LogBuffer, makeLogBuffer } from "../shared/flushable-logger.js"
import { makeMetricBuffer } from "../shared/flushable-metrics.js"
import { makeSpanBuffer, type SpanBuffer } from "../shared/flushable-tracer.js"
import { makeNoOpNotice } from "../shared/no-op-notice.js"
import { resolveResourceFromEnv } from "../server/resource.js"
import { SDK_VERSION } from "../version.js"

export interface Config {
	/**
	 * Service name reported in traces, logs, and metrics. Defaults to `env.OTEL_SERVICE_NAME`,
	 * then `"unknown"`.
	 */
	readonly serviceName?: string | undefined
	readonly serviceVersion?: string | undefined
	/**
	 * Canonical https URL of the source repository, emitted as
	 * `vcs.repository.url.full`. Falls back to `env.MAPLE_REPOSITORY_URL`, then
	 * GitHub Actions / Vercel git env metadata.
	 */
	readonly repositoryUrl?: string | undefined
	/**
	 * Logical group this service belongs to, emitted as the OTel
	 * `service.namespace` resource attribute. Optional — only stamped when set.
	 */
	readonly serviceNamespace?: string | undefined
	readonly environment?: string | undefined
	/**
	 * Ingest endpoint URL (base, no path). Defaults to `env.MAPLE_ENDPOINT`,
	 * then `env.OTEL_EXPORTER_OTLP_ENDPOINT`, then the public Maple ingest
	 * (`https://ingest.maple.dev`).
	 */
	readonly endpoint?: string | undefined
	/**
	 * Maple ingest key. Defaults to `env.MAPLE_INGEST_KEY`. When unset, the
	 * SDK runs in no-op mode (no flushes are attempted; buffers are drained
	 * so they don't grow across the isolate's lifetime).
	 */
	readonly ingestKey?: string | undefined
	readonly attributes?: Record<string, unknown> | undefined
	/** Skip Effect log spans in OTLP log attributes. Default `false`. */
	readonly excludeLogSpans?: boolean | undefined
	/**
	 * Span names whose prefix matches an entry here are dropped before they
	 * reach the OTLP exporter. Useful for suppressing protocol-level chatter
	 * (e.g. `"McpServer/Notifications."` for MCP notification spam).
	 */
	readonly dropSpanNames?: ReadonlyArray<string> | undefined
	/**
	 * Stable `_tag` / `Error.name` identifiers of anticipated 4xx failures. A span
	 * whose failure is caused entirely by these is exported with status `Ok` and
	 * no `exception` event, so it stays visible as a trace but never counts as an
	 * error.
	 */
	readonly anticipatedErrorIdentifiers?: ReadonlyArray<string> | undefined
	/** @deprecated Use `anticipatedErrorIdentifiers`. */
	readonly anticipatedErrorTags?: ReadonlyArray<string> | undefined
	/** OTLP traces path appended to `endpoint`. Default `/v1/traces`. */
	readonly tracesPath?: string | undefined
	/** OTLP logs path appended to `endpoint`. Default `/v1/logs`. */
	readonly logsPath?: string | undefined
	/** OTLP metrics path appended to `endpoint`. Default `/v1/metrics`. */
	readonly metricsPath?: string | undefined
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
	 * - No-op when no ingest key is configured (drains buffers, never POSTs;
	 *   logs one info line on first call so devs know telemetry is disabled).
	 * - Errors are caught and logged to `console.error`; cooldown of 60s
	 *   per signal before next attempt after a failure.
	 */
	flush(env: Record<string, unknown>): Promise<void>
}

const resolveOnce = (env: Record<string, unknown>, config: Config): Resolved => {
	const r = resolveResourceFromEnv(env, { ...config, sdkType: "cloudflare" })
	return buildResolved(r, {
		tracesPath: config.tracesPath,
		logsPath: config.logsPath,
		metricsPath: config.metricsPath,
		userAgent: `maple-effect-sdk-cloudflare/${SDK_VERSION}`,
	})
}

export const make = (config: Config = {}): Telemetry => {
	const dropPrefixes = config.dropSpanNames
	const dropSpan =
		dropPrefixes !== undefined && dropPrefixes.length > 0
			? (name: string) => dropPrefixes.some((prefix) => name.startsWith(prefix))
			: undefined
	const anticipatedErrorIdentifiers = [
		...(config.anticipatedErrorIdentifiers ?? []),
		...(config.anticipatedErrorTags ?? []),
	]
	const anticipatedIdentifiers =
		anticipatedErrorIdentifiers.length > 0 ? new Set(anticipatedErrorIdentifiers) : undefined
	const spans: SpanBuffer = makeSpanBuffer({
		dropSpan,
		anticipatedErrorIdentifiers: anticipatedIdentifiers,
	})
	const logs: LogBuffer = makeLogBuffer({ excludeLogSpans: config.excludeLogSpans })
	const metrics = makeMetricBuffer()

	let resolved: Resolved | undefined = undefined
	const noOpNotice = makeNoOpNotice("[MapleCloudflareSDK]", "set MAPLE_INGEST_KEY to enable")
	const tracesState: SignalState = { disabledUntil: 0 }
	const logsState: SignalState = { disabledUntil: 0 }
	const metricsState: SignalState = { disabledUntil: 0 }

	const layer = Layer.mergeAll(spans.tracerLayer, logs.loggerLayer, metrics.layer)

	// Never rejects: this runs inside `ctx.waitUntil`, where a rejection would
	// surface as an unhandled Worker error caused purely by telemetry.
	const flush = makeSerializedFlush(
		guardFlush("[MapleCloudflareSDK]", async (env: Record<string, unknown>): Promise<void> => {
			// Effect defers work onto the scheduler's next macrotask
			// (`scheduleTask(task, 0)`) — including `HttpMiddleware.tracer`'s
			// `span.end` and `withSpan` finalizers — while the drain below is
			// synchronous. Flushing in the same task therefore misses exactly the
			// spans the request just produced, and an isolated request (e.g. a lone
			// webhook) can freeze the isolate before a later flush rescues them.
			// Yield one macrotask so those tasks run first. This sits INSIDE the
			// serialized body, so overlapping flushes still queue rather than
			// interleave.
			await new Promise<void>((resolve) => setTimeout(resolve, 0))

			if (resolved === undefined) {
				resolved = resolveOnce(env, config)
			}

			await runFlush({
				resolved,
				spans,
				logs,
				metrics,
				tracesState,
				logsState,
				metricsState,
				transport: fetchTransport,
				logPrefix: "[MapleCloudflareSDK]",
				onNoOp: noOpNotice,
			})
		}),
	)

	return { layer, flush }
}

// Convenience namespace export so call sites read as
// `MapleCloudflareSDK.make({...})` when imported as a default.
export const MapleCloudflareSDK = { make }

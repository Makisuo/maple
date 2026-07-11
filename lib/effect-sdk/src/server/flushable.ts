// ---------------------------------------------------------------------------
// Server flushable preset — manual `flush()` for Node/Bun/Deno
//
// `Maple.layer` (the `Otlp.layerJson`-based server preset) batches in the
// background and flushes only on a timer, on batch overflow, or on scope close
// — it exposes no way to force an export. This preset trades that background
// fiber for the buffer-backed tracer/logger used by the Cloudflare SDK and adds
// an explicit `flush()`, so a short-lived process can force its spans out at a
// checkpoint (or before exiting) instead of losing them.
//
//   import { MapleFlush } from "@maple-dev/effect-sdk/server"
//   const telemetry = MapleFlush.make({ serviceName: "my-app" })
//   // ...provide telemetry.layer to your runtime...
//   await telemetry.flush()        // force an export now
//   await telemetry.dispose()      // stop the auto-flush timer + final flush
//
// Known limitation: traces + logs only (no metrics, unlike `Otlp.layerJson`).
// ---------------------------------------------------------------------------

import { Effect, Layer } from "effect"
import {
	buildResolved,
	fetchTransport,
	type Resolved,
	runFlush,
	type SignalState,
} from "../shared/flush-core.js"
import { type LogBuffer, makeLogBuffer } from "../shared/flushable-logger.js"
import { makeSpanBuffer, type SpanBuffer } from "../shared/flushable-tracer.js"
import { resolveResource } from "./resource.js"

/** Default auto-flush cadence (ms), matching `Otlp.layerJson`'s 5s export interval. */
const DEFAULT_AUTO_FLUSH_MS = 5_000

export interface MapleFlushableConfig {
	/**
	 * Service name reported in traces and logs. Falls back to `OTEL_SERVICE_NAME`,
	 * then `"unknown"`.
	 */
	readonly serviceName?: string | undefined
	/** Override auto-detected service version (commit SHA). */
	readonly serviceVersion?: string | undefined
	/**
	 * Logical group this service belongs to, emitted as the OTel
	 * `service.namespace` resource attribute. Optional — only stamped when set.
	 */
	readonly serviceNamespace?: string | undefined
	/** Override auto-detected deployment environment. */
	readonly environment?: string | undefined
	/**
	 * Ingest endpoint URL. Falls back to `MAPLE_ENDPOINT`, then
	 * `OTEL_EXPORTER_OTLP_ENDPOINT`, then the public Maple ingest.
	 */
	readonly endpoint?: string | undefined
	/** Maple ingest key. Falls back to `MAPLE_INGEST_KEY`. When unset, runs in no-op mode. */
	readonly ingestKey?: string | undefined
	/** Additional resource attributes (highest precedence). */
	readonly attributes?: Record<string, unknown> | undefined
	/** Skip Effect log spans in OTLP log attributes. Default `false`. */
	readonly excludeLogSpans?: boolean | undefined
	/** Span name prefixes to drop before OTLP export. */
	readonly dropSpanNames?: ReadonlyArray<string> | undefined
	/**
	 * `_tag`s of *anticipated* failures (expected 4xx business errors). Spans
	 * failing entirely with these export as status `Ok` (no `exception` event),
	 * so they stay visible but never count as errors.
	 */
	readonly anticipatedErrorTags?: ReadonlyArray<string> | undefined
	/** OTLP traces path appended to `endpoint`. Default `/v1/traces`. */
	readonly tracesPath?: string | undefined
	/** OTLP logs path appended to `endpoint`. Default `/v1/logs`. */
	readonly logsPath?: string | undefined
	/**
	 * Background auto-flush cadence in milliseconds. Default `5000`. Set to `0`
	 * or `false` to disable and flush purely on demand (note: the in-memory
	 * buffer caps at 10k items and drops new spans past that, so a long-running
	 * process that never flushes will lose data).
	 */
	readonly autoFlushInterval?: number | false | undefined
}

export interface FlushableTelemetry {
	/**
	 * Effect Layer installing the buffer-backed OTLP tracer + Effect logger.
	 * Must live in the same runtime as your instrumented code (same caveat as
	 * the Cloudflare preset's `layer`).
	 */
	readonly layer: Layer.Layer<never>
	/** Drain the buffers and POST them now. Never rejects (errors are logged + cooled down). */
	readonly flush: () => Promise<void>
	/** Stop the auto-flush timer, then do one final flush. */
	readonly dispose: () => Promise<void>
}

export const make = (config: MapleFlushableConfig = {}): FlushableTelemetry => {
	const dropPrefixes = config.dropSpanNames
	const dropSpan =
		dropPrefixes !== undefined && dropPrefixes.length > 0
			? (name: string) => dropPrefixes.some((prefix) => name.startsWith(prefix))
			: undefined
	const anticipatedErrorTags =
		config.anticipatedErrorTags !== undefined && config.anticipatedErrorTags.length > 0
			? new Set(config.anticipatedErrorTags)
			: undefined
	const spans: SpanBuffer = makeSpanBuffer({ dropSpan, anticipatedErrorTags })
	const logs: LogBuffer = makeLogBuffer({ excludeLogSpans: config.excludeLogSpans })
	const layer = Layer.mergeAll(spans.tracerLayer, logs.loggerLayer)

	const tracesState: SignalState = { disabledUntil: 0 }
	const logsState: SignalState = { disabledUntil: 0 }
	let noOpLogged = false

	// Resolve the resource once, lazily, on first flush. Memoize the PROMISE (not
	// the result) so a manual flush racing the auto-flush timer can't kick off two
	// `resolveResource` runs. `resolveResource` reads env via the default
	// ConfigProvider, so this keeps commit-SHA/environment auto-detection without
	// making `make()` async or reading env at module scope.
	let resolvedPromise: Promise<Resolved> | undefined
	const ensureResolved = (): Promise<Resolved> => {
		if (resolvedPromise === undefined) {
			resolvedPromise = Effect.runPromise(resolveResource({ ...config, sdkType: "server" })).then((r) =>
				buildResolved(r, {
					tracesPath: config.tracesPath,
					logsPath: config.logsPath,
					userAgent: "maple-effect-sdk-server/0.0.0",
				}),
			)
		}
		return resolvedPromise
	}

	const flush = async (): Promise<void> => {
		const resolved = await ensureResolved()
		await runFlush({
			resolved,
			spans,
			logs,
			tracesState,
			logsState,
			transport: fetchTransport,
			logPrefix: "[MapleServerSDK]",
			onNoOp: () => {
				if (!noOpLogged) {
					noOpLogged = true
					console.info(
						"[MapleServerSDK] no ingest key configured — telemetry disabled (set MAPLE_INGEST_KEY to enable)",
					)
				}
			},
		})
	}

	const intervalMs =
		config.autoFlushInterval === undefined
			? DEFAULT_AUTO_FLUSH_MS
			: config.autoFlushInterval === false
				? 0
				: config.autoFlushInterval
	let timer: ReturnType<typeof setInterval> | undefined
	if (intervalMs > 0) {
		timer = setInterval(() => {
			void flush()
		}, intervalMs)
		// Node only: a flush timer must never keep the process alive on its own.
		;(timer as { unref?: () => void }).unref?.()
	}

	const dispose = async (): Promise<void> => {
		if (timer !== undefined) {
			clearInterval(timer)
			timer = undefined
		}
		await flush()
	}

	return { layer, flush, dispose }
}

// ---------------------------------------------------------------------------
// Client flushable preset — manual `flush()` for the browser
//
// `Maple.layer` (the `Otlp.layerJson`-based client preset) exports on a 5s
// timer but never flushes on page unload — the scope doesn't close on
// `pagehide`, so the last few seconds of spans (including replay-linked traces)
// are silently lost. This preset swaps the Otlp layer for the buffer-backed
// tracer/logger and adds an explicit `flush()` plus, by default, a `pagehide` /
// `visibilitychange→hidden` handler that flushes the tail before the tab goes
// away — the browser equivalent of the Cloudflare preset's `ctx.waitUntil`.
//
//   import { MapleFlush } from "@maple-dev/effect-sdk/client"
//   const telemetry = MapleFlush.make({
//     serviceName: "my-frontend",
//     endpoint: "https://ingest.maple.dev",
//     ingestKey: "maple_pk_...",
//   })
//   // ...provide telemetry.layer to your runtime...
//
// Flush uses `fetch(url, { keepalive: true })`, not `navigator.sendBeacon`:
// Maple's ingest gateway authenticates via the `Authorization` header (no
// query-param auth), and sendBeacon cannot set request headers, so it would
// 401 whenever an ingest key is set. `keepalive` carries the header AND lets
// the request outlive the unloading document (for small bodies).
//
// Known limitation: traces + logs only (no metrics, unlike `Otlp.layerJson`).
// ---------------------------------------------------------------------------

import { Layer, Redacted } from "effect"
import {
	buildResolved,
	type FlushTransport,
	type Resolved,
	type ResourceInput,
	runFlush,
	type SignalState,
} from "../shared/flush-core.js"
import { type LogBuffer, makeLogBuffer } from "../shared/flushable-logger.js"
import { makeSpanBuffer, type SpanBuffer } from "../shared/flushable-tracer.js"
import { withSessionLink } from "./session-link.js"

/** Default auto-flush cadence (ms), matching `Otlp.layerJson`'s 5s export interval. */
const DEFAULT_AUTO_FLUSH_MS = 5_000

export interface MapleClientFlushableConfig {
	/** Service name reported in traces and logs. */
	readonly serviceName: string
	/** Maple ingest endpoint URL. */
	readonly endpoint: string
	/** Maple ingest key. When unset, the preset runs in no-op mode. */
	readonly ingestKey?: string | undefined
	/** Service version or commit SHA. */
	readonly serviceVersion?: string | undefined
	/** Deployment environment (e.g. "production", "staging"). */
	readonly environment?: string | undefined
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
	 * buffer caps at 10k items, so a long-lived tab that never flushes will
	 * eventually drop new spans).
	 */
	readonly autoFlushInterval?: number | false | undefined
	/**
	 * Register `pagehide` + `visibilitychange→hidden` listeners that flush the
	 * buffer before the tab goes away. Default `true`. No-ops when there's no
	 * `addEventListener` (SSR / non-DOM runtime).
	 */
	readonly flushOnUnload?: boolean | undefined
}

export interface FlushableTelemetry {
	/**
	 * Effect Layer installing the buffer-backed OTLP tracer (with replay-session
	 * linking) + Effect logger. Must live in the same runtime as your
	 * instrumented code.
	 */
	readonly layer: Layer.Layer<never>
	/** Drain the buffers and POST them now (keepalive). Never rejects. */
	readonly flush: () => Promise<void>
	/** Remove unload listeners, stop the auto-flush timer, then do one final flush. */
	readonly dispose: () => Promise<void>
}

/** `fetch(keepalive)` transport — see file header for why not `sendBeacon`. */
const keepaliveTransport: FlushTransport = {
	post: async (url, headers, body) => {
		const res = await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			keepalive: true,
		})
		if (!res.ok) throw new Error(`OTLP ${res.status} ${res.statusText}`)
	},
}

const buildBrowserAttributes = (config: MapleClientFlushableConfig): Record<string, unknown> => {
	const attributes: Record<string, unknown> = { "maple.sdk.type": "client" }
	const g = globalThis as Record<string, any>
	if (typeof g["navigator"] !== "undefined") {
		const nav = g["navigator"]
		if (nav.userAgent) attributes["browser.user_agent"] = nav.userAgent
		if (nav.language) attributes["browser.language"] = nav.language
	}
	if (typeof Intl !== "undefined") {
		try {
			attributes["browser.timezone"] = Intl.DateTimeFormat().resolvedOptions().timeZone
		} catch {}
	}
	if (config.environment) {
		// Dual-emit: legacy key (pre-extracted by Tinybird MVs) + the canonical
		// resource attribute. Keep both until the MVs coalesce them.
		attributes["deployment.environment"] = config.environment
		attributes["deployment.environment.name"] = config.environment
	}
	if (config.serviceVersion) attributes["deployment.commit_sha"] = config.serviceVersion
	if (config.attributes) Object.assign(attributes, config.attributes)
	return attributes
}

export const make = (config: MapleClientFlushableConfig): FlushableTelemetry => {
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
	// `withSessionLink` overrides only the Tracer reference, keeping the logger.
	const layer = withSessionLink(Layer.mergeAll(spans.tracerLayer, logs.loggerLayer))

	// Config is fully programmatic in the browser — resolve eagerly. No
	// `process.env`, no server `resolveResource` (keeps this out of the client
	// bundle).
	const resource: ResourceInput = {
		endpoint: config.endpoint,
		ingestKey: config.ingestKey ? Redacted.make(config.ingestKey) : undefined,
		resource: {
			serviceName: config.serviceName,
			serviceVersion: config.serviceVersion,
			attributes: buildBrowserAttributes(config),
		},
	}
	const resolved: Resolved = buildResolved(resource, {
		tracesPath: config.tracesPath,
		logsPath: config.logsPath,
		userAgent: "maple-effect-sdk-client/0.0.0",
	})

	const tracesState: SignalState = { disabledUntil: 0 }
	const logsState: SignalState = { disabledUntil: 0 }
	let noOpLogged = false

	const flush = async (): Promise<void> => {
		await runFlush({
			resolved,
			spans,
			logs,
			tracesState,
			logsState,
			transport: keepaliveTransport,
			logPrefix: "[MapleClientSDK]",
			onNoOp: () => {
				if (!noOpLogged) {
					noOpLogged = true
					console.info(
						"[MapleClientSDK] no ingest key configured — telemetry disabled (pass `ingestKey` to enable)",
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
		;(timer as { unref?: () => void }).unref?.()
	}

	const onPageHide = (): void => {
		void flush()
	}
	const onVisibilityChange = (): void => {
		const doc = (globalThis as Record<string, any>)["document"]
		if (doc && doc.visibilityState === "hidden") void flush()
	}
	const canListen = (config.flushOnUnload ?? true) && typeof globalThis.addEventListener === "function"
	if (canListen) {
		globalThis.addEventListener("pagehide", onPageHide)
		globalThis.addEventListener("visibilitychange", onVisibilityChange)
	}

	const dispose = async (): Promise<void> => {
		if (timer !== undefined) {
			clearInterval(timer)
			timer = undefined
		}
		if (canListen) {
			globalThis.removeEventListener("pagehide", onPageHide)
			globalThis.removeEventListener("visibilitychange", onVisibilityChange)
		}
		await flush()
	}

	return { layer, flush, dispose }
}

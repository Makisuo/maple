// Browser telemetry preset with explicit and unload-triggered flushes for
// buffered traces, logs, and metric snapshots. Transport uses keepalive fetch:
// unlike sendBeacon it can carry the ingest key's Authorization header.

import { hasConsent, onConsentChange } from "@maple/browser-session"
import { makeNoOpNotice } from "../shared/no-op-notice.js"
import { SDK_VERSION } from "../version.js"
import { Layer, Redacted } from "effect"
import {
	buildResolved,
	type FlushTransport,
	guardFlush,
	makeSerializedFlush,
	type Resolved,
	type ResourceInput,
	runFlush,
	type SignalState,
} from "../shared/flush-core.js"
import { type LogBuffer, makeLogBuffer } from "../shared/flushable-logger.js"
import { makeMetricBuffer } from "../shared/flushable-metrics.js"
import { type CaptureExceptionOptions, makeSpanBuffer, type SpanBuffer } from "../shared/flushable-tracer.js"
import { browserDocument, browserNavigator } from "./browser-globals.js"
import { trySyncOrUndefined } from "../shared/try-sync.js"
import { type ClientReplayConfig, startClientSession } from "./replay-loader.js"
import { withSessionLink } from "./session-link.js"
import type { PrivacyOptions } from "./track.js"

/** Default auto-flush cadence (ms), matching `Otlp.layerJson`'s 5s export interval. */
const DEFAULT_AUTO_FLUSH_MS = 5_000

const browserInstanceId =
	globalThis.crypto?.randomUUID?.() ??
	`browser-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

export interface MapleClientFlushableConfig {
	/** Service name reported in traces, logs, and metrics. */
	readonly serviceName: string
	/** Maple ingest endpoint URL. */
	readonly endpoint: string
	/** Maple ingest key. When unset, the preset runs in no-op mode. */
	readonly ingestKey?: string | undefined
	/** Service version or commit SHA. */
	readonly serviceVersion?: string | undefined
	/**
	 * Logical group this service belongs to, emitted as the OTel
	 * `service.namespace` resource attribute. Optional — only stamped when set.
	 */
	readonly serviceNamespace?: string | undefined
	/** Deployment environment (e.g. "production", "staging"). */
	readonly environment?: string | undefined
	/** Additional resource attributes (highest precedence). */
	readonly attributes?: Record<string, unknown> | undefined
	/** Skip Effect log spans in OTLP log attributes. Default `false`. */
	readonly excludeLogSpans?: boolean | undefined
	/** Span name prefixes to drop before OTLP export. */
	readonly dropSpanNames?: ReadonlyArray<string> | undefined
	/**
	 * Stable `_tag` / `Error.name` identifiers of anticipated 4xx failures. Spans
	 * failing entirely with these export as status `Ok` (no `exception` event),
	 * so they stay visible but never count as errors.
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
	/**
	 * Post session metadata rows for the standalone session so it appears in
	 * Maple's Sessions UI (list entry + linked traces, no replay recording).
	 * Default `true`; no-ops when `@maple-dev/browser` is on the page (it owns
	 * the session rows), during SSR, or without an ingest key.
	 */
	readonly emitSessionMeta?: boolean | undefined
	/**
	 * rrweb session replay for this app, recorded by the shared Maple replay
	 * engine (loaded lazily in a code-split chunk). Default enabled with
	 * sampleRate 1 and inputs masked — set `{ enabled: false }` to opt out.
	 */
	readonly replay?: ClientReplayConfig | undefined
	/**
	 * Capture uncaught errors and unhandled promise rejections from the page and
	 * record them as error spans. Default `true`.
	 *
	 * Without this the SDK only ever sees failures that happened *inside* an
	 * Effect span, which in a browser is the minority of them — a React render
	 * crash, a throw in an event handler and a floating rejected promise all
	 * bypass Effect entirely and would otherwise never reach Maple.
	 */
	readonly captureGlobalErrors?: boolean | undefined
	/**
	 * Consent gating, persistent-visitor-id storage, and whether `identify()`'s
	 * email reaches the warehouse. Defaults capture everything except where a
	 * browser signals otherwise: Global Privacy Control suppresses the
	 * persistent visitor id (capture itself continues, anonymously).
	 */
	readonly privacy?: PrivacyOptions | undefined
}

export interface FlushableTelemetry {
	/**
	 * Effect Layer installing the buffer-backed OTLP tracer (with replay-session
	 * linking) + Effect logger. Must live in the same runtime as your
	 * instrumented code.
	 */
	readonly layer: Layer.Layer<never>
	/**
	 * Record an error that never passed through an Effect span — the escape
	 * hatch for the places a browser throws outside Effect. The canonical caller
	 * is a React error boundary, which catches the error and, unless it reports
	 * it here, is the reason nobody ever hears about the crash.
	 *
	 * BOUNDARY: a thrown value is unparsed by definition — JavaScript can throw
	 * anything. It is narrowed on the way into the exception event.
	 */
	readonly captureException: (error: unknown, options?: CaptureExceptionOptions) => void
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
	const attributes: Record<string, unknown> = {
		"maple.sdk.type": "client",
		"service.instance.id": browserInstanceId,
	} satisfies Record<string, unknown>
	const nav = browserNavigator()
	if (nav) {
		// `user_agent.original` is the semconv key; `browser.user_agent` was
		// deprecated in favour of it.
		if (nav.userAgent) attributes["user_agent.original"] = nav.userAgent
		if (nav.language) attributes["browser.language"] = nav.language
	}
	if (typeof Intl !== "undefined") {
		// A locale-stripped build throws from `DateTimeFormat` rather than
		// reporting an unknown zone.
		const timezone = trySyncOrUndefined(() => Intl.DateTimeFormat().resolvedOptions().timeZone)
		if (timezone) attributes["browser.timezone"] = timezone
	}
	if (config.environment) {
		// Dual-emit: legacy key (pre-extracted by Tinybird MVs) + the canonical
		// resource attribute. Keep both until the MVs coalesce them.
		attributes["deployment.environment"] = config.environment
		attributes["deployment.environment.name"] = config.environment
	}
	// `serviceVersion` may be a semver release string, which belongs in
	// `service.version` but not in `vcs.*` — only a SHA-shaped value is stamped.
	if (config.serviceVersion && /^[0-9a-f]{7,40}$/i.test(config.serviceVersion)) {
		attributes["vcs.ref.head.revision"] = config.serviceVersion
	}
	if (config.serviceNamespace) attributes["service.namespace"] = config.serviceNamespace
	if (config.attributes) Object.assign(attributes, config.attributes)
	return attributes
}

export const make = (config: MapleClientFlushableConfig): FlushableTelemetry => {
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
	const clientSession = startClientSession({
		endpoint: config.endpoint,
		ingestKey: config.ingestKey,
		serviceName: config.serviceName,
		environment: config.environment,
		serviceVersion: config.serviceVersion,
		replay: config.replay,
		emitSessionMeta: config.emitSessionMeta,
		privacy: config.privacy,
	})

	const spans: SpanBuffer = makeSpanBuffer({
		dropSpan,
		anticipatedErrorIdentifiers: anticipatedIdentifiers,
	})
	const logs: LogBuffer = makeLogBuffer({
		excludeLogSpans: config.excludeLogSpans,
	})
	const metrics = makeMetricBuffer()
	const setCaptureAllowed = (allowed: boolean): void => {
		spans.setDisabled(!allowed)
		logs.setDisabled(!allowed)
		metrics.setDisabled(!allowed)
	}
	setCaptureAllowed(hasConsent())
	const stopConsentListener = config.privacy?.requireConsent ? onConsentChange(setCaptureAllowed) : () => {}
	// `withSessionLink` overrides only the Tracer reference, keeping the logger.
	const layer = withSessionLink(Layer.mergeAll(spans.tracerLayer, logs.loggerLayer, metrics.layer))

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
		metricsPath: config.metricsPath,
		userAgent: `maple-effect-sdk-client/${SDK_VERSION}`,
	})

	const tracesState: SignalState = { disabledUntil: 0 }
	const logsState: SignalState = { disabledUntil: 0 }
	const metricsState: SignalState = { disabledUntil: 0 }
	const noOpNotice = makeNoOpNotice("[MapleClientSDK]", "pass `ingestKey` to enable")

	// Never rejects — fired from `pagehide`/`visibilitychange` handlers and the
	// auto-flush timer as `void flush()`.
	const flush = makeSerializedFlush(
		guardFlush("[MapleClientSDK]", async (): Promise<void> => {
			if (!hasConsent()) {
				spans.drain()
				logs.drain()
				metrics.drain()
				return
			}
			await runFlush({
				resolved,
				spans,
				logs,
				metrics,
				tracesState,
				logsState,
				metricsState,
				transport: keepaliveTransport,
				logPrefix: "[MapleClientSDK]",
				onNoOp: noOpNotice,
			})
		}),
	)

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

	/**
	 * One error reaching two paths must still be one issue. React rethrows a
	 * boundary-caught error in development, so a boundary that reports it *and*
	 * `window.onerror` would otherwise fingerprint the same crash twice.
	 */
	const reported = new WeakSet<object>()
	const captureException = (error: unknown, options: CaptureExceptionOptions = {}): void => {
		if (typeof error === "object" && error !== null) {
			if (reported.has(error)) return
			reported.add(error)
		}
		const page = globalThis.location?.href
		spans.captureException(error, {
			...options,
			attributes: {
				...(page !== undefined ? { "url.full": page } : undefined),
				...options.attributes,
			},
		})
	}

	const onWindowError = (event: ErrorEvent): void => {
		// A cross-origin script reports as a bare "Script error." with no error
		// object, no usable frames and no filename. It fingerprints to a single
		// meaningless issue that buries the real ones, so it is dropped rather
		// than recorded — the fix for those is CORS on the script tag, not a
		// louder error tracker.
		const error: unknown =
			event.error ?? (event.message && event.filename ? new Error(event.message) : undefined)
		if (error === undefined) return
		captureException(error, {
			name: "browser.uncaught_error",
			attributes: {
				"maple.exception.source": "window.onerror",
				// `code.file.path` / `code.line.number` since semconv v1.34.0. Nothing
				// reads the names they replaced, so they are dropped rather than
				// dual-emitted — carrying both would put four near-identical rows on
				// every uncaught error in the attribute list.
				...(event.filename ? { "code.file.path": event.filename } : undefined),
				...(event.lineno ? { "code.line.number": event.lineno } : undefined),
			},
		})
	}

	const onUnhandledRejection = (event: PromiseRejectionEvent): void => {
		captureException(event.reason, {
			name: "browser.unhandled_rejection",
			attributes: { "maple.exception.source": "unhandledrejection" },
		})
	}

	const canCaptureGlobals =
		(config.captureGlobalErrors ?? true) && typeof globalThis.addEventListener === "function"
	if (canCaptureGlobals) {
		globalThis.addEventListener("error", onWindowError)
		globalThis.addEventListener("unhandledrejection", onUnhandledRejection)
	}

	const onPageHide = (): void => {
		void flush()
	}
	const onVisibilityChange = (): void => {
		if (browserDocument()?.visibilityState === "hidden") void flush()
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
		if (canCaptureGlobals) {
			globalThis.removeEventListener("error", onWindowError)
			globalThis.removeEventListener("unhandledrejection", onUnhandledRejection)
		}
		stopConsentListener()
		await flush()
		await clientSession.stop()
	}

	return { layer, captureException, flush, dispose }
}

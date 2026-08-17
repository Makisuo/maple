// Server-side product events — the backend twin of the browser SDK's `track()`.
//
// Browser `track()` calls ride the session-events stream. A backend has no
// session, but it is the only place that knows about the events that matter
// most for a funnel — `signup_completed`, `plan_started` — so this posts them
// straight to the ingest gateway's `POST /v1/events` (NDJSON, one event per
// line), keyed to a person by `userId` / `groupId` / `visitorId`.
//
//   import { MapleEvents } from "@maple-dev/effect-sdk/server"
//
//   // Effect: provide `MapleEvents.layer(...)`, then
//   const events = yield* MapleEvents.MapleEvents
//   yield* events.track("plan_started", { userId, groupId, attributes: { plan } })
//
//   // Promise-land:
//   const events = MapleEvents.makeHandle({ serviceName: "billing" })
//   events.track("plan_started", { userId, attributes: { plan } })
//   await events.dispose()  // on shutdown: final flush
//
// Events are buffered and flushed on an interval, on batch size, and on scope
// close / `dispose()`. `track` never fails and never throws into the caller —
// a broken ingest endpoint drops the batch and warns (rate-limited).

import { coerceTrackProps, MAX_EVENT_NAME_LENGTH, type TrackProps } from "@maple/browser-session/props"
import {
	Cause,
	Context,
	Duration,
	Effect,
	Layer,
	ManagedRuntime,
	Option,
	Redacted,
	Schedule,
	Schema,
	Semaphore,
} from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { SDK_VERSION } from "../version.js"
import { resolveResource } from "./resource.js"

export type { TrackProps }

/** Default flush cadence, matching the OTLP exporters' 5s interval. */
const DEFAULT_FLUSH_INTERVAL = Duration.seconds(5)
/** Batch size that triggers an early flush. */
const DEFAULT_MAX_BATCH_SIZE = 100
/** Hard cap on buffered events; oldest are dropped past it. */
const MAX_BUFFERED_EVENTS = 1_000
/** How often a failing endpoint may warn. */
const WARN_INTERVAL_MS = 30_000

export interface MapleEventsConfig {
	/**
	 * Stamped as `service_name` on every event. Falls back to
	 * `OTEL_SERVICE_NAME`, then `"unknown"`.
	 */
	readonly serviceName?: string | undefined
	/**
	 * Ingest endpoint URL. Falls back to `MAPLE_ENDPOINT`, then
	 * `OTEL_EXPORTER_OTLP_ENDPOINT`, then the public Maple ingest.
	 */
	readonly endpoint?: string | undefined
	/** Maple ingest key. Falls back to `MAPLE_INGEST_KEY`. Without one, events are dropped. */
	readonly ingestKey?: string | undefined
	/** Path appended to `endpoint`. Default `/v1/events`. */
	readonly eventsPath?: string | undefined
	/** Background flush cadence. Default 5 seconds. */
	readonly flushInterval?: Duration.Input | undefined
	/** Flush as soon as this many events are buffered. Default 100. */
	readonly maxBatchSize?: number | undefined
}

/** Who and where a server-side event belongs to. Every field is optional. */
export interface TrackOptions {
	/** The signed-in user (`identify()`'s id on the browser side). */
	readonly userId?: string | undefined
	/** Company / team / tenant the user acts within. */
	readonly groupId?: string | undefined
	/** Browser visitor id, when the backend has it (e.g. forwarded from a cookie). */
	readonly visitorId?: string | undefined
	/** Browser session id, when the event belongs to one. */
	readonly sessionId?: string | undefined
	/** When the event happened. Default: now. */
	readonly timestamp?: Date | number | undefined
	/** Page the event happened on, when known. */
	readonly url?: string | undefined
	readonly pagePath?: string | undefined
	/** Free-form properties; coerced to strings and capped like the browser `track()`. */
	readonly attributes?: TrackProps | undefined
}

/** One NDJSON line for `POST /v1/events`. `org_id` comes from the ingest key. */
interface ProductEventLine {
	readonly name: string
	readonly timestamp: string
	readonly source: "server"
	readonly service_name: string
	readonly visitor_id: string
	readonly user_id: string
	readonly group_id: string
	readonly session_id: string
	readonly url: string
	readonly page_path: string
	readonly attributes: Record<string, string>
}

export interface MapleEventsApi {
	/** Buffer one event. Never fails; an invalid name is dropped with a one-shot warning. */
	readonly track: (name: string, options?: TrackOptions) => Effect.Effect<void>
	/** Post everything buffered now. Never fails; a failed POST drops the batch and warns. */
	readonly flush: Effect.Effect<void>
}

export class MapleEvents extends Context.Service<MapleEvents, MapleEventsApi>()(
	"@maple-dev/effect-sdk/MapleEvents",
) {}

/** The ingest gateway refused (or never answered) a batch. Logged, never surfaced to `track` callers. */
export class ProductEventsPostError extends Schema.TaggedError<ProductEventsPostError>()(
	"@maple-dev/effect-sdk/ProductEventsPostError",
	{
		message: Schema.String,
		status: Schema.optionalKey(Schema.Number),
		cause: Schema.optionalKey(Schema.Defect()),
	},
) {}

const toTimestamp = (value: Date | number | undefined): string =>
	(value instanceof Date ? value : new Date(value ?? Date.now())).toISOString()

/**
 * Build the client against whatever `HttpClient` is in context, so tests can
 * stub the transport and `layer` can supply `FetchHttpClient`. Scoped: the
 * background flush fiber and the final drain are tied to the scope.
 */
export const make = Effect.fn("MapleEvents.make")(function* (config: MapleEventsConfig = {}) {
	const resolved = yield* resolveResource({
		serviceName: config.serviceName,
		endpoint: config.endpoint,
		ingestKey: config.ingestKey,
		sdkType: "server",
	})
	const url = `${resolved.endpoint.replace(/\/$/, "")}${config.eventsPath ?? "/v1/events"}`
	const ingestKey = resolved.ingestKey ? Redacted.value(resolved.ingestKey) : undefined
	const serviceName = resolved.resource.serviceName
	const maxBatchSize = Math.max(1, config.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE)
	const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk)
	// One POST in flight at a time, so a size-triggered flush and the interval
	// never race the same buffer.
	const flushing = yield* Semaphore.make(1)

	let buffer: Array<ProductEventLine> = []
	let warnedAboutName = false
	let warnedAboutKey = false
	let lastPostWarnAt = 0

	const warnPost = (error: ProductEventsPostError): void => {
		const now = Date.now()
		if (now - lastPostWarnAt < WARN_INTERVAL_MS) return
		lastPostWarnAt = now
		console.warn(`[MapleEvents] ${error.message} (dropping batch)`, error.cause ?? "")
	}
	// Host-app-facing developer warnings, same posture as `warnIfDoomed` in
	// layer.ts: these go to the console, not to the Effect logger, because the
	// SDK's own logger may be exporting to the very endpoint that is misconfigured.
	const warnMissingKey = (): void => {
		if (warnedAboutKey) return
		warnedAboutKey = true
		console.warn(
			"[MapleEvents] no ingest key — set MAPLE_INGEST_KEY or pass `ingestKey`; dropping events",
		)
	}
	const warnEmptyName = (): void => {
		if (warnedAboutName) return
		warnedAboutName = true
		console.warn("[MapleEvents] track() needs a non-empty event name; the call was ignored.")
	}

	const post = (lines: ReadonlyArray<ProductEventLine>) =>
		HttpClientRequest.post(url).pipe(
			HttpClientRequest.setHeaders({
				Authorization: `Bearer ${ingestKey}`,
				"user-agent": `maple-effect-sdk-server/${SDK_VERSION}`,
			}),
			HttpClientRequest.bodyText(
				`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
				"application/x-ndjson",
			),
			client.execute,
			Effect.asVoid,
			Effect.mapError((error) =>
				error.response !== undefined
					? new ProductEventsPostError({
							message: `POST ${url} → ${error.response.status}`,
							status: error.response.status,
						})
					: new ProductEventsPostError({
							message: `POST ${url} failed: ${error.message}`,
							cause: error,
						}),
			),
		)

	const flush: Effect.Effect<void> = flushing.withPermits(1)(
		Effect.suspend(() => {
			if (buffer.length === 0) return Effect.void
			const batch = buffer
			buffer = []
			if (ingestKey === undefined) {
				warnMissingKey()
				return Effect.void
			}
			return post(batch).pipe(
				Effect.catchCause((cause) =>
					Effect.sync(() => {
						warnPost(
							Option.getOrElse(
								Cause.findErrorOption(cause),
								() =>
									new ProductEventsPostError({
										message: `POST ${url} failed`,
										cause: Cause.squash(cause),
									}),
							),
						)
					}),
				),
			)
		}),
	)

	const track = (name: string, options: TrackOptions = {}): Effect.Effect<void> =>
		Effect.sync(() => {
			const trimmed = typeof name === "string" ? name.trim() : ""
			if (trimmed.length === 0) {
				warnEmptyName()
				return false
			}
			buffer.push({
				name: trimmed.slice(0, MAX_EVENT_NAME_LENGTH),
				timestamp: toTimestamp(options.timestamp),
				source: "server",
				service_name: serviceName,
				visitor_id: options.visitorId ?? "",
				user_id: options.userId ?? "",
				group_id: options.groupId ?? "",
				session_id: options.sessionId ?? "",
				url: options.url ?? "",
				page_path: options.pagePath ?? "",
				attributes: coerceTrackProps(options.attributes),
			})
			if (buffer.length > MAX_BUFFERED_EVENTS) buffer.splice(0, buffer.length - MAX_BUFFERED_EVENTS)
			return buffer.length >= maxBatchSize
		}).pipe(
			// The size-triggered flush is forked so `track` returns immediately;
			// the semaphore keeps it from overlapping the interval flush.
			Effect.flatMap((full) => (full ? Effect.forkDetach(flush) : Effect.void)),
			Effect.asVoid,
		)

	const interval = config.flushInterval ?? DEFAULT_FLUSH_INTERVAL
	if (Duration.toMillis(interval) > 0) {
		yield* Effect.forkScoped(flush.pipe(Effect.schedule(Schedule.spaced(interval))))
	}
	// Scope close (layer teardown / `dispose()`) drains what is left.
	yield* Effect.addFinalizer(() => flush)

	return { track, flush } satisfies MapleEventsApi
})

/**
 * `MapleEvents` service backed by `FetchHttpClient`. Provide it alongside
 * `Maple.layer`; the scope that owns it flushes on close.
 */
export const layer = (config: MapleEventsConfig = {}): Layer.Layer<MapleEvents> =>
	Layer.effect(MapleEvents, make(config)).pipe(Layer.provide(FetchHttpClient.layer))

export interface MapleEventsHandle {
	/** Buffer one event. Fire-and-forget; never throws. */
	readonly track: (name: string, options?: TrackOptions) => void
	/** Post everything buffered now. Never rejects. */
	readonly flush: () => Promise<void>
	/** Final flush, then release the runtime. Never rejects. */
	readonly dispose: () => Promise<void>
}

/**
 * Promise-land handle for apps that are not (yet) Effect end to end. Owns its
 * own runtime; call `dispose()` on shutdown so the last batch goes out.
 */
export const makeHandle = (config: MapleEventsConfig = {}): MapleEventsHandle => {
	const runtime = ManagedRuntime.make(layer(config))
	const swallow = (promise: Promise<unknown>): Promise<void> =>
		promise.then(
			() => undefined,
			() => undefined,
		)
	return {
		track: (name, options) => {
			void swallow(runtime.runPromise(MapleEvents.use((events) => events.track(name, options))))
		},
		flush: () => swallow(runtime.runPromise(MapleEvents.use((events) => events.flush))),
		dispose: () => swallow(runtime.dispose()),
	}
}

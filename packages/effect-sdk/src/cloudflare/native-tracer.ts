// Cloudflare-native tracer — the opt-in `tracer: "native"` mode of the Workers
// preset.
//
// Every sampled Effect span is mirrored onto `tracing.startActiveSpan` from
// `cloudflare:workers`, so it lands in the same trace as Cloudflare's own
// auto-instrumented spans (fetch, KV, R2, D1, …) and is exported by the
// customer's ObservabilityDestination. Nothing is buffered, nothing is
// flushed, no ingest key is involved, and it works from Durable Object and
// Workflow isolates where a `ctx.waitUntil` flush is unreliable.
//
// Cloudflare parents a new span under whatever span is active on the JS
// async context, and `startActiveSpan` keeps its span active only while its
// callback runs. Effect fibers hop across async contexts on every yield, so
// left alone a child opened after a `sleep` would attach to the request's
// root span. Each mirrored span therefore captures `AsyncLocalStorage.snapshot()`
// from inside its callback, children are opened inside their parent's
// snapshot, and the tracer's `context` hook runs every fiber step inside the
// current span's snapshot — which is also what puts the runtime's own
// fetch/KV/R2/D1 spans under the right Effect span.
//
// Cloudflare spans carry only scalar attributes: no events, links, or status.
// Scalars are forwarded as they are set; everything else stays on the Effect
// span. A failed exit is mirrored as `exception.type` / `exception.message` /
// `exception.stacktrace` / `error.type` attributes in place of the OTLP
// `exception` event, and a server span that answered 5xx gets the same
// treatment (OTEL HTTP semconv, shared with the OTLP path). Effect trace and span ids are independent of
// Cloudflare's — `Effect.currentSpan` keeps working, but its ids are not the
// ones in the exported trace.

import { Effect, Layer, Option, Predicate, Schema, Tracer } from "effect"
import { classifySpanExit, HTTP_SERVER_ERROR_RESPONSE } from "../shared/span-exit.js"

/**
 * Structural view of the span `tracing.startActiveSpan` hands its callback.
 * Typed here rather than imported: `@cloudflare/workers-types` predates
 * `startActiveSpan`, and the SDK must not require Workers types to build.
 */
export interface NativeSpanHandle {
	/** Cloudflare's head-sampling decision for this invocation. */
	readonly isTraced: boolean
	setAttribute(key: string, value?: boolean | number | string): void
	end(): void
}

export interface NativeTracing {
	startActiveSpan<T>(name: string, callback: (span: NativeSpanHandle) => T): T
}

/** What `AsyncLocalStorage.snapshot()` returns: runs a thunk inside the captured async context. */
export type AsyncSnapshot = <T>(fn: () => T) => T

export interface NativeTracerHost {
	readonly tracing: NativeTracing
	readonly snapshot: () => AsyncSnapshot
}

export interface NativeTracerOptions {
	/** Same contract as the OTLP preset: a matching name is kept Effect-local, children attach to the nearest mirrored ancestor. */
	readonly dropSpan?: ((name: string) => boolean) | undefined
	/** Same contract as the OTLP preset: a failure made entirely of these gets no `exception.*` attributes. */
	readonly anticipatedErrorIdentifiers?: ReadonlySet<string> | undefined
}

/** Raised while resolving the host APIs; the layer turns it into the Effect-local fallback. */
export class NativeTracingUnavailable extends Schema.TaggedError<NativeTracingUnavailable>()(
	"@maple-dev/effect-sdk/cloudflare/NativeTracingUnavailable",
	{
		message: Schema.String,
		cause: Schema.optionalKey(Schema.Defect()),
	},
) {}

type SpanOptions = Parameters<Tracer.Tracer["span"]>[0]

const ATTR_EXCEPTION_TYPE = "exception.type"
const ATTR_EXCEPTION_MESSAGE = "exception.message"
const ATTR_EXCEPTION_STACKTRACE = "exception.stacktrace"
const ATTR_ERROR_TYPE = "error.type"
const ATTR_STATUS_INTERRUPTED = "status.interrupted"

const isScalar = (value: unknown): value is boolean | number | string =>
	Predicate.isString(value) || Predicate.isNumber(value) || Predicate.isBoolean(value)

class MirroredSpan extends Tracer.NativeSpan {
	/** Async context to run this span's fibers in: the parent's, or `undefined` for the ambient one. */
	readonly runIn: AsyncSnapshot | undefined
	readonly handle: NativeSpanHandle | undefined
	readonly #anticipated: ReadonlySet<string> | undefined

	constructor(
		options: SpanOptions,
		runIn: AsyncSnapshot | undefined,
		handle: NativeSpanHandle | undefined,
		sampled: boolean,
		anticipated: ReadonlySet<string> | undefined,
	) {
		super({ ...options, sampled })
		this.runIn = runIn
		this.handle = handle
		this.#anticipated = anticipated
	}

	override attribute(key: string, value: unknown): void {
		super.attribute(key, value)
		if (this.handle !== undefined && isScalar(value)) this.handle.setAttribute(key, value)
	}

	override end(endTime: bigint, exit: Parameters<Tracer.Span["end"]>[1]): void {
		super.end(endTime, exit)
		const handle = this.handle
		if (handle === undefined) return
		const outcome = classifySpanExit(
			{ exit, kind: this.kind, attributes: this.attributes },
			this.#anticipated,
		)
		if (outcome._tag === "ServerError") {
			handle.setAttribute(ATTR_EXCEPTION_TYPE, HTTP_SERVER_ERROR_RESPONSE)
			handle.setAttribute(ATTR_EXCEPTION_MESSAGE, outcome.message)
			handle.setAttribute(ATTR_ERROR_TYPE, HTTP_SERVER_ERROR_RESPONSE)
		} else if (outcome._tag === "Interrupted") {
			handle.setAttribute(ATTR_STATUS_INTERRUPTED, true)
		} else if (outcome._tag === "Failed") {
			// One scalar per key: the first error is the one Maple fingerprints on,
			// exactly as the OTLP path's first `exception` event is.
			const first = outcome.errors[0]
			if (first !== undefined) {
				handle.setAttribute(ATTR_EXCEPTION_TYPE, first.name)
				handle.setAttribute(ATTR_EXCEPTION_MESSAGE, first.message)
				handle.setAttribute(ATTR_EXCEPTION_STACKTRACE, first.stack ?? "No stack trace available")
				handle.setAttribute(ATTR_ERROR_TYPE, first.name)
			}
		}
		handle.end()
	}
}

// The nearest mirrored ancestor decides the async context. The walk stops at
// an `ExternalSpan` (a propagated parent has no Cloudflare span of its own).
const runInFor = (span: Tracer.AnySpan | undefined): AsyncSnapshot | undefined => {
	let current = span
	while (current !== undefined && current._tag === "Span") {
		if (current instanceof MirroredSpan) return current.runIn
		current = Option.getOrUndefined(current.parent)
	}
	return undefined
}

export const makeNativeTracer = (
	host: NativeTracerHost,
	options: NativeTracerOptions = {},
): Tracer.Tracer => {
	const { tracing, snapshot } = host
	const dropSpan = options.dropSpan
	const anticipated = options.anticipatedErrorIdentifiers

	return Tracer.make({
		span(spanOptions) {
			const parentRun = spanOptions.root
				? undefined
				: runInFor(Option.getOrUndefined(spanOptions.parent))
			if (!spanOptions.sampled) {
				return new MirroredSpan(spanOptions, parentRun, undefined, false, anticipated)
			}
			if (dropSpan !== undefined && dropSpan(spanOptions.name)) {
				return new MirroredSpan(spanOptions, parentRun, undefined, true, anticipated)
			}
			// Snapshot from inside the callback: that is the only frame in which
			// the new Cloudflare span is active.
			const open = () =>
				tracing.startActiveSpan(
					spanOptions.name,
					(handle) =>
						new MirroredSpan(spanOptions, snapshot(), handle, handle.isTraced, anticipated),
				)
			return parentRun === undefined ? open() : parentRun(open)
		},
		context(primitive, fiber) {
			const run = runInFor(fiber.currentSpan)
			return run === undefined
				? primitive["~effect/Effect/evaluate"](fiber)
				: run(() => primitive["~effect/Effect/evaluate"](fiber))
		},
	})
}

// Host resolution
//
// Both modules are imported dynamically, and by a non-literal specifier, so
// neither the SDK bundle nor a Worker on an older compatibility date (or one
// without `nodejs_compat`) fails at module load. A missing API degrades to
// Effect-local spans through `NativeTracingUnavailable`.

const isNativeTracing = (value: unknown): value is NativeTracing =>
	Predicate.hasProperty(value, "startActiveSpan") && Predicate.isFunction(value.startActiveSpan)

const isAsyncHooks = (
	value: unknown,
): value is { readonly AsyncLocalStorage: { readonly snapshot: () => AsyncSnapshot } } =>
	Predicate.hasProperty(value, "AsyncLocalStorage") &&
	Predicate.hasProperty(value.AsyncLocalStorage, "snapshot") &&
	Predicate.isFunction(value.AsyncLocalStorage.snapshot)

/** A module namespace: named exports whose shapes are checked by the guards above. */
export interface ModuleNamespace {
	readonly [name: string]: unknown
}
export type ModuleImporter = (specifier: string) => Promise<ModuleNamespace>

const importSpecifier: ModuleImporter = (specifier) => import(/* @vite-ignore */ specifier)

export const resolveNativeTracerHost = (
	importModule: ModuleImporter,
): Effect.Effect<NativeTracerHost, NativeTracingUnavailable> =>
	Effect.gen(function* () {
		const load = (specifier: string) =>
			Effect.tryPromise({
				try: () => importModule(specifier),
				catch: (cause) =>
					new NativeTracingUnavailable({ message: `${specifier} could not be imported`, cause }),
			})
		const workers = yield* load("cloudflare:workers")
		const tracing = Predicate.hasProperty(workers, "tracing") ? workers.tracing : undefined
		if (!isNativeTracing(tracing)) {
			return yield* new NativeTracingUnavailable({
				message:
					"cloudflare:workers exposes no `tracing.startActiveSpan` — it needs compatibility_date >= 2026-07-28",
			})
		}
		const asyncHooks = yield* load("node:async_hooks")
		if (!isAsyncHooks(asyncHooks)) {
			return yield* new NativeTracingUnavailable({
				message:
					"node:async_hooks exposes no `AsyncLocalStorage.snapshot` — enable the nodejs_compat compatibility flag",
			})
		}
		return { tracing, snapshot: () => asyncHooks.AsyncLocalStorage.snapshot() }
	})

const effectLocalTracer = Tracer.make({ span: (options) => new Tracer.NativeSpan(options) })

/**
 * Tracer layer for native mode. Builds asynchronously (the host modules are
 * imported on first build); when the host APIs are absent it logs one notice
 * and installs Effect-local spans instead.
 */
export const makeNativeTracerLayer = (
	options: NativeTracerOptions,
	host: Effect.Effect<NativeTracerHost, NativeTracingUnavailable> = resolveNativeTracerHost(
		importSpecifier,
	),
): Layer.Layer<never> =>
	Layer.effect(
		Tracer.Tracer,
		host.pipe(
			Effect.map((resolved) => makeNativeTracer(resolved, options)),
			Effect.catchTag("@maple-dev/effect-sdk/cloudflare/NativeTracingUnavailable", (error) =>
				Effect.logInfo(
					`[MapleCloudflareSDK] native tracing unavailable — spans stay Effect-local (${error.message})`,
				).pipe(Effect.as(effectLocalTracer)),
			),
		),
	)

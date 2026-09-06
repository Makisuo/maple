import { assert, describe, it } from "@effect/vitest"
import { Data, Effect, Fiber, Layer, Logger, Option, Predicate, Tracer } from "effect"
import * as ErrorReporter from "effect/ErrorReporter"
import { expect } from "vitest"
import {
	type AsyncSnapshot,
	makeNativeTracer,
	makeNativeTracerLayer,
	type NativeSpanHandle,
	type NativeTracing,
	NativeTracingUnavailable,
	resolveNativeTracerHost,
} from "./native-tracer.js"

// The package typechecks without Node's globals on purpose (it also ships to
// browsers), so the real AsyncLocalStorage — the point of these tests — is
// loaded the way the tracer itself loads it: dynamically, behind a guard.
interface AsyncStore<T> {
	run<R>(store: T, fn: () => R): R
	getStore(): T | undefined
}
type AsyncHooksModule = {
	readonly AsyncLocalStorage: (new <T>() => AsyncStore<T>) & { snapshot(): AsyncSnapshot }
}
const isAsyncHooksModule = (value: unknown): value is AsyncHooksModule =>
	Predicate.hasProperty(value, "AsyncLocalStorage") && Predicate.isFunction(value.AsyncLocalStorage)
const asyncHooksSpecifier = "node:async_hooks"
const loadedAsyncHooks: unknown = await import(/* @vite-ignore */ asyncHooksSpecifier)
const asyncHooks: AsyncHooksModule = isAsyncHooksModule(loadedAsyncHooks)
	? loadedAsyncHooks
	: assert.fail("node:async_hooks is unavailable")
const { AsyncLocalStorage } = asyncHooks

// A stand-in for `cloudflare:workers`' `tracing`: the active span lives in an
// AsyncLocalStorage, exactly like the runtime's async-context parenting, and
// `startActiveSpan` keeps its span active only while the callback runs.
class FakeSpan implements NativeSpanHandle {
	readonly attributes: Record<string, boolean | number | string> = {}
	ended = 0
	constructor(
		readonly name: string,
		readonly parent: FakeSpan | undefined,
		readonly isTraced: boolean,
	) {}
	setAttribute(key: string, value?: boolean | number | string): void {
		if (value !== undefined) this.attributes[key] = value
	}
	end(): void {
		this.ended += 1
	}
}

const makeFakeHost = (options: { readonly isTraced?: boolean } = {}) => {
	const active = new AsyncLocalStorage<FakeSpan>()
	const spans: Array<FakeSpan> = []
	const tracing: NativeTracing = {
		startActiveSpan(name, callback) {
			const span = new FakeSpan(name, active.getStore(), options.isTraced ?? true)
			spans.push(span)
			return active.run(span, () => callback(span))
		},
	}
	return {
		tracing,
		spans,
		snapshot: () => AsyncLocalStorage.snapshot(),
		/** The span Cloudflare would parent a runtime-created span under right now. */
		activeSpan: () => active.getStore(),
		byName: (name: string) => spans.find((span) => span.name === name),
	}
}

// Resumes the fiber from an async context with no active span — what a
// scheduler hop looks like to the runtime.
const outside = AsyncLocalStorage.snapshot()
const hop = Effect.promise(() => outside(() => new Promise<void>((resolve) => setTimeout(resolve, 1))))

const withTracer = (host: ReturnType<typeof makeFakeHost>) =>
	Effect.provideService(Tracer.Tracer, makeNativeTracer(host))

class Boom extends Data.TaggedError("Boom")<{ readonly message: string }> {}
class NotFound extends Data.TaggedError("NotFound")<{}> {}
class Benign extends Data.TaggedError("Benign")<{}> {
	readonly [ErrorReporter.ignore] = true
}

describe("makeNativeTracer", () => {
	it.effect("mirrors nested spans with the same parentage, ending each once", () =>
		Effect.gen(function* () {
			const host = makeFakeHost()
			yield* Effect.withSpan("child")(Effect.void).pipe(Effect.withSpan("parent"), withTracer(host))
			const parent = host.byName("parent")
			const child = host.byName("child")
			assert.isDefined(parent)
			assert.isDefined(child)
			assert.strictEqual(child.parent, parent)
			assert.strictEqual(parent.ended, 1)
			assert.strictEqual(child.ended, 1)
		}),
	)

	it.effect("keeps parentage across a scheduler hop that lands in a foreign async context", () =>
		Effect.gen(function* () {
			const host = makeFakeHost()
			yield* Effect.gen(function* () {
				yield* hop
				yield* Effect.withSpan("child")(Effect.void)
			}).pipe(Effect.withSpan("parent"), withTracer(host))
			assert.strictEqual(host.byName("child")?.parent, host.byName("parent"))
		}),
	)

	it.effect(
		"runs fiber steps inside the current span's async context, so runtime spans nest under it",
		() =>
			Effect.gen(function* () {
				const host = makeFakeHost()
				const seen = yield* Effect.gen(function* () {
					const before = yield* Effect.sync(() => host.activeSpan()?.name)
					yield* hop
					const after = yield* Effect.sync(() => host.activeSpan()?.name)
					return { before, after }
				}).pipe(Effect.withSpan("parent"), withTracer(host))
				assert.deepStrictEqual(seen, { before: "parent", after: "parent" })
			}),
	)

	// Within one continuation the ambient context can still be the span that
	// just ended (a documented limitation), so this checks from a fresh one.
	it("a fiber with no span runs in the ambient async context", async () => {
		const host = makeFakeHost()
		const bare = await outside(() =>
			Effect.runPromise(Effect.sync(() => host.activeSpan()).pipe(withTracer(host))),
		)
		assert.isUndefined(bare)
	})

	it.effect("interleaved fibers each stay under their own span", () =>
		Effect.gen(function* () {
			const host = makeFakeHost()
			const work = (label: string) =>
				Effect.gen(function* () {
					yield* hop
					const active = yield* Effect.sync(() => host.activeSpan()?.name)
					yield* Effect.withSpan(`${label}.child`)(Effect.void)
					return active
				}).pipe(Effect.withSpan(label))
			const [a, b] = yield* Effect.all([Effect.forkChild(work("a")), Effect.forkChild(work("b"))]).pipe(
				Effect.flatMap(([fa, fb]) => Effect.all([Fiber.join(fa), Fiber.join(fb)])),
				withTracer(host),
			)
			assert.strictEqual(a, "a")
			assert.strictEqual(b, "b")
			assert.strictEqual(host.byName("a.child")?.parent, host.byName("a"))
			assert.strictEqual(host.byName("b.child")?.parent, host.byName("b"))
		}),
	)

	it.effect("forwards scalar attributes and keeps the rest Effect-local", () =>
		Effect.gen(function* () {
			const host = makeFakeHost()
			const effectAttributes = yield* Effect.gen(function* () {
				yield* Effect.annotateCurrentSpan({
					"a.string": "x",
					"a.number": 1,
					"a.boolean": true,
					"a.object": { nested: 1 },
					"a.array": [1, 2],
					"a.bigint": 1n,
				})
				const span = yield* Effect.currentSpan
				return new Map(span.attributes)
			}).pipe(Effect.withSpan("op"), withTracer(host))
			assert.deepStrictEqual(host.byName("op")?.attributes, {
				"a.string": "x",
				"a.number": 1,
				"a.boolean": true,
			})
			assert.strictEqual(effectAttributes.size, 6)
			assert.deepStrictEqual(effectAttributes.get("a.object"), { nested: 1 })
		}),
	)

	it.effect("mirrors a failure as exception.* and error.type attributes", () =>
		Effect.gen(function* () {
			const host = makeFakeHost()
			yield* Effect.fail(new Boom({ message: "boom" })).pipe(
				Effect.withSpan("op"),
				withTracer(host),
				Effect.exit,
			)
			const attributes = host.byName("op")?.attributes ?? {}
			assert.strictEqual(attributes["exception.type"], "Boom")
			assert.strictEqual(attributes["exception.message"], "boom")
			assert.strictEqual(attributes["error.type"], "Boom")
			expect(attributes["exception.stacktrace"]).toEqual(expect.stringContaining("boom"))
			assert.strictEqual(host.byName("op")?.ended, 1)
		}),
	)

	it.effect("mirrors a defect the same way", () =>
		Effect.gen(function* () {
			const host = makeFakeHost()
			yield* Effect.die(new TypeError("unexpected")).pipe(
				Effect.withSpan("op"),
				withTracer(host),
				Effect.exit,
			)
			const attributes = host.byName("op")?.attributes ?? {}
			assert.strictEqual(attributes["exception.type"], "TypeError")
			assert.strictEqual(attributes["exception.message"], "unexpected")
		}),
	)

	it.effect("sets no exception attributes on success", () =>
		Effect.gen(function* () {
			const host = makeFakeHost()
			yield* Effect.void.pipe(Effect.withSpan("op"), withTracer(host))
			assert.deepStrictEqual(host.byName("op")?.attributes, {})
		}),
	)

	it.effect("flags an interrupt instead of recording an exception", () =>
		Effect.gen(function* () {
			const host = makeFakeHost()
			yield* Effect.interrupt.pipe(Effect.withSpan("op"), withTracer(host), Effect.exit)
			assert.deepStrictEqual(host.byName("op")?.attributes, { "status.interrupted": true })
		}),
	)

	it.effect("anticipated and ignored failures set no exception attributes", () =>
		Effect.gen(function* () {
			const host = makeFakeHost()
			const tracer = makeNativeTracer(host, { anticipatedErrorIdentifiers: new Set(["NotFound"]) })
			const provide = Effect.provideService(Tracer.Tracer, tracer)
			yield* Effect.fail(new NotFound()).pipe(Effect.withSpan("anticipated"), provide, Effect.exit)
			yield* Effect.fail(new Benign()).pipe(Effect.withSpan("ignored"), provide, Effect.exit)
			assert.deepStrictEqual(host.byName("anticipated")?.attributes, {})
			assert.deepStrictEqual(host.byName("ignored")?.attributes, {})
		}),
	)

	it.effect("mirrors a rendered 5xx on a server span as an HttpServerErrorResponse exception", () =>
		Effect.gen(function* () {
			const host = makeFakeHost()
			const respond = (name: string, status: number, kind: "server" | "internal") =>
				Effect.annotateCurrentSpan({
					"http.request.method": "GET",
					"url.path": "/api/items",
					"http.response.status_code": status,
				}).pipe(Effect.withSpan(name, { kind }), withTracer(host))
			yield* respond("server-500", 500, "server")
			yield* respond("server-404", 404, "server")
			yield* respond("internal-503", 503, "internal")
			const failed = host.byName("server-500")?.attributes ?? {}
			assert.strictEqual(failed["exception.type"], "HttpServerErrorResponse")
			assert.strictEqual(failed["exception.message"], "HTTP 500 (GET /api/items)")
			assert.strictEqual(failed["error.type"], "HttpServerErrorResponse")
			assert.isUndefined(host.byName("server-404")?.attributes["exception.type"])
			assert.isUndefined(host.byName("internal-503")?.attributes["exception.type"])
		}),
	)

	it.effect("cascades Cloudflare's isTraced=false into Effect's sampled and opens no descendants", () =>
		Effect.gen(function* () {
			const host = makeFakeHost({ isTraced: false })
			const sampled = yield* Effect.gen(function* () {
				yield* Effect.withSpan("child")(Effect.void)
				const span = yield* Effect.currentSpan
				return span.sampled
			}).pipe(Effect.withSpan("parent"), withTracer(host))
			assert.isFalse(sampled)
			assert.deepStrictEqual(
				host.spans.map((span) => span.name),
				["parent"],
			)
		}),
	)

	it.effect(
		"a dropped span name stays Effect-local and its children attach to the nearest mirrored ancestor",
		() =>
			Effect.gen(function* () {
				const host = makeFakeHost()
				const tracer = makeNativeTracer(host, { dropSpan: (name) => name.startsWith("noise.") })
				yield* Effect.withSpan("child")(Effect.void).pipe(
					Effect.withSpan("noise.notification"),
					Effect.withSpan("parent"),
					Effect.provideService(Tracer.Tracer, tracer),
				)
				assert.deepStrictEqual(
					host.spans.map((span) => span.name),
					["parent", "child"],
				)
				assert.strictEqual(host.byName("child")?.parent, host.byName("parent"))
			}),
	)

	it.effect("Effect span ids stay independent of the mirrored span", () =>
		Effect.gen(function* () {
			const host = makeFakeHost()
			const ids = yield* Effect.currentSpan.pipe(
				Effect.map((span) => ({ traceId: span.traceId, spanId: span.spanId, parent: span.parent })),
				Effect.withSpan("op"),
				withTracer(host),
			)
			expect(ids.traceId).toMatch(/^[0-9a-f]{32}$/)
			expect(ids.spanId).toMatch(/^[0-9a-f]{16}$/)
			assert.isTrue(Option.isNone(ids.parent))
		}),
	)
})

describe("resolveNativeTracerHost", () => {
	it.effect(
		"resolves when cloudflare:workers exposes startActiveSpan and node:async_hooks a snapshot",
		() =>
			Effect.gen(function* () {
				const { tracing } = makeFakeHost()
				const host = yield* resolveNativeTracerHost((specifier) =>
					Promise.resolve(specifier === "cloudflare:workers" ? { tracing } : asyncHooks),
				)
				assert.strictEqual(host.tracing, tracing)
				assert.strictEqual(
					host.snapshot()(() => 42),
					42,
				)
			}),
	)

	it.effect("fails with a compatibility-date hint when tracing has no startActiveSpan", () =>
		Effect.gen(function* () {
			const error = yield* resolveNativeTracerHost((specifier) =>
				Promise.resolve(
					specifier === "cloudflare:workers"
						? { tracing: { enterSpan: () => undefined } }
						: asyncHooks,
				),
			).pipe(Effect.flip)
			assert.instanceOf(error, NativeTracingUnavailable)
			expect(error.message).toContain("compatibility_date")
		}),
	)

	it.effect("fails with a nodejs_compat hint when AsyncLocalStorage.snapshot is missing", () =>
		Effect.gen(function* () {
			const { tracing } = makeFakeHost()
			const error = yield* resolveNativeTracerHost((specifier) =>
				Promise.resolve(specifier === "cloudflare:workers" ? { tracing } : {}),
			).pipe(Effect.flip)
			expect(error.message).toContain("nodejs_compat")
		}),
	)

	it.effect("fails when the module cannot be imported at all", () =>
		Effect.gen(function* () {
			const error = yield* resolveNativeTracerHost(() =>
				Promise.reject(new Error("No such module")),
			).pipe(Effect.flip)
			expect(error.message).toContain("cloudflare:workers")
		}),
	)
})

describe("makeNativeTracerLayer", () => {
	it.effect("falls back to Effect-local spans, with one notice, when the host is unavailable", () =>
		Effect.gen(function* () {
			const notices: Array<string> = []
			const capture = Logger.make<unknown, void>(({ message }) => {
				notices.push(Array.isArray(message) ? message.join(" ") : String(message))
			})
			const layer = makeNativeTracerLayer(
				{},
				Effect.fail(new NativeTracingUnavailable({ message: "no cloudflare:workers here" })),
			).pipe(Layer.provide(Logger.layer([capture])))
			const span = yield* Effect.currentSpan.pipe(Effect.withSpan("op"), Effect.provide(layer))
			assert.strictEqual(span.name, "op")
			assert.isTrue(span.sampled)
			assert.strictEqual(notices.length, 1)
			expect(notices[0]).toContain("native tracing unavailable")
			expect(notices[0]).toContain("no cloudflare:workers here")
		}),
	)

	it.effect("installs the mirroring tracer when the host resolves", () =>
		Effect.gen(function* () {
			const host = makeFakeHost()
			const layer = makeNativeTracerLayer({}, Effect.succeed(host))
			yield* Effect.withSpan("child")(Effect.void).pipe(
				Effect.withSpan("parent"),
				Effect.provide(layer),
			)
			assert.strictEqual(host.byName("child")?.parent, host.byName("parent"))
		}),
	)
})

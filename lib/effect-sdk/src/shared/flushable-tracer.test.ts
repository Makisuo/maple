import { assert, describe, it } from "@effect/vitest"
import { Data, Effect } from "effect"
import * as ErrorReporter from "effect/ErrorReporter"
import * as HttpServerError from "effect/unstable/http/HttpServerError"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import { makeSpanBuffer } from "./flushable-tracer.js"

// A benign error flagged exactly the way Effect's RouteNotFound is.
class BenignError extends Data.TaggedError("BenignError")<{}> {
	readonly [ErrorReporter.ignore] = true
}
// A real reportable failure (no ignore flag) — e.g. a 400/500.
class ReportableError extends Data.TaggedError("ReportableError")<{}> {}

// An anticipated 4xx business error (e.g. unauthorized / not-found).
class UnauthorizedError extends Data.TaggedError("UnauthorizedError")<{}> {}

const runSpan = (buffer: ReturnType<typeof makeSpanBuffer>, effect: Effect.Effect<unknown, unknown>) =>
	effect.pipe(Effect.withSpan("http.server GET"), Effect.provide(buffer.tracerLayer), Effect.exit)

describe("makeSpanBuffer ignored-failure drop", () => {
	it.effect("drops spans whose failure carries [ErrorReporter.ignore]", () =>
		Effect.gen(function* () {
			const buffer = makeSpanBuffer()
			yield* runSpan(buffer, Effect.fail(new BenignError()))
			assert.strictEqual(buffer.size(), 0)
		}),
	)

	it.effect("keeps spans that fail with a reportable error", () =>
		Effect.gen(function* () {
			const buffer = makeSpanBuffer()
			yield* runSpan(buffer, Effect.fail(new ReportableError()))
			assert.strictEqual(buffer.size(), 1)
		}),
	)

	it.effect("keeps successful spans", () =>
		Effect.gen(function* () {
			const buffer = makeSpanBuffer()
			yield* runSpan(buffer, Effect.succeed(undefined))
			assert.strictEqual(buffer.size(), 1)
		}),
	)

	// Pins the upstream contract: the actual error HttpRouter raises for an
	// unmatched route must stay [ErrorReporter.ignore]-flagged, so the drop holds.
	it.effect("drops the real HttpServerError/RouteNotFound", () =>
		Effect.gen(function* () {
			const buffer = makeSpanBuffer()
			const request = HttpServerRequest.fromWeb(new Request("http://localhost/nope"))
			const error = new HttpServerError.HttpServerError({
				reason: new HttpServerError.RouteNotFound({ request }),
			})
			yield* runSpan(buffer, Effect.fail(error))
			assert.strictEqual(buffer.size(), 0)
		}),
	)
})

describe("makeSpanBuffer anticipated-error classification", () => {
	const tags = new Set(["UnauthorizedError"])

	it.effect("keeps an anticipated failure as an Ok span with no exception event", () =>
		Effect.gen(function* () {
			const buffer = makeSpanBuffer({ anticipatedErrorTags: tags })
			yield* runSpan(buffer, Effect.fail(new UnauthorizedError()))
			const [span] = buffer.drain()
			assert.isDefined(span)
			assert.strictEqual(span!.status.code, 1 /* Ok */)
			assert.strictEqual(
				span!.events.some((event) => event.name === "exception"),
				false,
			)
		}),
	)

	it.effect("still marks an unclassified failure as an Error span with an exception event", () =>
		Effect.gen(function* () {
			const buffer = makeSpanBuffer({ anticipatedErrorTags: tags })
			yield* runSpan(buffer, Effect.fail(new ReportableError()))
			const [span] = buffer.drain()
			assert.isDefined(span)
			assert.strictEqual(span!.status.code, 2 /* Error */)
			assert.strictEqual(
				span!.events.some((event) => event.name === "exception"),
				true,
			)
		}),
	)

	it.effect("marks Error when an anticipated error is mixed with a defect", () =>
		Effect.gen(function* () {
			const buffer = makeSpanBuffer({ anticipatedErrorTags: tags })
			yield* runSpan(
				buffer,
				Effect.fail(new UnauthorizedError()).pipe(Effect.ensuring(Effect.die("boom"))),
			)
			const [span] = buffer.drain()
			assert.isDefined(span)
			assert.strictEqual(span!.status.code, 2 /* Error */)
		}),
	)

	it.effect("marks Error for an anticipated tag when no tags are configured", () =>
		Effect.gen(function* () {
			const buffer = makeSpanBuffer()
			yield* runSpan(buffer, Effect.fail(new UnauthorizedError()))
			const [span] = buffer.drain()
			assert.isDefined(span)
			assert.strictEqual(span!.status.code, 2 /* Error */)
		}),
	)

	// An interrupt co-occurring with an anticipated failure is NOT an error:
	// interrupts are normal fiber control flow, so the span stays Ok (unlike a
	// defect, which forces Error). Pins the Die-vs-Interrupt asymmetry.
	it.effect("keeps Ok when an anticipated error is mixed with an interrupt", () =>
		Effect.gen(function* () {
			const buffer = makeSpanBuffer({ anticipatedErrorTags: tags })
			yield* runSpan(
				buffer,
				Effect.fail(new UnauthorizedError()).pipe(Effect.ensuring(Effect.interrupt)),
			)
			const [span] = buffer.drain()
			assert.isDefined(span)
			assert.strictEqual(span!.status.code, 1 /* Ok */)
			assert.strictEqual(
				span!.events.some((event) => event.name === "exception"),
				false,
			)
		}),
	)
})

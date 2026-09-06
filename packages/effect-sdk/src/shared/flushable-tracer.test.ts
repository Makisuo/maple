import { assert, describe, it } from "@effect/vitest"
import { Data, Effect, Schema } from "effect"
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
class V2InvalidRequestError extends Schema.Error<V2InvalidRequestError>("@maple/http/v2/InvalidRequestError")(
	{ error: Schema.Struct({ type: Schema.Literal("invalid_request_error") }) },
) {}

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

	it.effect("keeps a mixed ignored failure and defect", () =>
		Effect.gen(function* () {
			const buffer = makeSpanBuffer()
			yield* runSpan(buffer, Effect.fail(new BenignError()).pipe(Effect.ensuring(Effect.die("boom"))))
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

	it.effect("classifies Schema.Error failures by Error.name", () =>
		Effect.gen(function* () {
			const buffer = makeSpanBuffer({
				anticipatedErrorIdentifiers: new Set(["@maple/http/v2/InvalidRequestError"]),
			})
			yield* runSpan(
				buffer,
				Effect.fail(new V2InvalidRequestError({ error: { type: "invalid_request_error" } })),
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

	// The shape a decoded HTTP error body actually has on the client: an `{ error }`
	// envelope, not a class. Without the unwrap an API using that convention
	// matches *no* configured identifier at all, and every expected 4xx records
	// `Error` with the stringified envelope as its whole message.
	it.effect("classifies a decoded `{ error: { _tag } }` envelope by the body's tag", () =>
		Effect.gen(function* () {
			const buffer = makeSpanBuffer({
				anticipatedErrorIdentifiers: new Set(["@maple/http/v2/SessionReplayRangeTooLargeError"]),
			})
			yield* runSpan(
				buffer,
				Effect.fail({
					error: {
						_tag: "@maple/http/v2/SessionReplayRangeTooLargeError",
						type: "invalid_request_error",
						code: "range_too_large",
						message: "That part of the recording is too large to load in one request.",
					},
				}),
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

	it.effect("leaves an envelope whose tag is not anticipated an Error span", () =>
		Effect.gen(function* () {
			const buffer = makeSpanBuffer({
				anticipatedErrorIdentifiers: new Set(["@maple/http/v2/SessionReplayRangeTooLargeError"]),
			})
			yield* runSpan(buffer, Effect.fail({ error: { _tag: "@maple/http/errors/PersistenceError" } }))
			const [span] = buffer.drain()
			assert.isDefined(span)
			assert.strictEqual(span!.status.code, 2 /* Error */)
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

describe("makeSpanBuffer rendered 5xx responses", () => {
	// A server span whose handler answered with a plain response — no failure in
	// the Effect, only the status code the HTTP tracer stamps on the span.
	const respond = (
		buffer: ReturnType<typeof makeSpanBuffer>,
		status: number,
		kind: "server" | "internal",
	) =>
		Effect.annotateCurrentSpan({
			"http.request.method": "GET",
			"url.path": "/api/sync/shape",
			"http.response.status_code": status,
		}).pipe(Effect.withSpan("http.server GET", { kind }), Effect.provide(buffer.tracerLayer))

	it.effect("records a 5xx on a server span as Error with an exception event", () =>
		Effect.gen(function* () {
			const buffer = makeSpanBuffer()
			yield* respond(buffer, 500, "server")
			const [span] = buffer.drain()
			assert.isDefined(span)
			assert.strictEqual(span!.status.code, 2 /* Error */)
			assert.strictEqual(span!.status.message, "HTTP 500 (GET /api/sync/shape)")
			const exception = span!.events.find((event) => event.name === "exception")
			assert.isDefined(exception)
			assert.deepStrictEqual(
				exception!.attributes.find((attribute) => attribute.key === "exception.type")?.value,
				{ stringValue: "HttpServerErrorResponse" },
			)
		}),
	)

	it.effect("leaves a 4xx server span Ok", () =>
		Effect.gen(function* () {
			const buffer = makeSpanBuffer()
			yield* respond(buffer, 404, "server")
			const [span] = buffer.drain()
			assert.strictEqual(span?.status.code, 1 /* Ok */)
			assert.strictEqual(span?.events.length, 0)
		}),
	)

	it.effect("ignores the status code on non-server spans", () =>
		Effect.gen(function* () {
			const buffer = makeSpanBuffer()
			yield* respond(buffer, 503, "internal")
			const [span] = buffer.drain()
			assert.strictEqual(span?.status.code, 1 /* Ok */)
		}),
	)
})

describe("makeSpanBuffer restore", () => {
	it.effect("keeps older failed telemetry and discards newest overflow", () =>
		Effect.gen(function* () {
			const buffer = makeSpanBuffer()
			yield* runSpan(buffer, Effect.succeed("old"))
			const [oldest] = buffer.drain()
			yield* Effect.succeed(undefined).pipe(
				Effect.withSpan("newest"),
				Effect.provide(buffer.tracerLayer),
			)
			const [newest] = buffer.drain()
			assert.isDefined(oldest)
			assert.isDefined(newest)

			buffer.restore([oldest!, ...Array.from({ length: 10_000 }, () => newest!)])
			const restored = buffer.drain()
			assert.strictEqual(restored.length, 10_000)
			assert.strictEqual(restored[0]?.name, "http.server GET")
			assert.strictEqual(restored.at(-1)?.name, "newest")
		}),
	)
})

const attributeOf = (span: { attributes: ReadonlyArray<{ key: string; value: unknown }> }, key: string) =>
	span.attributes.find((attribute) => attribute.key === key)?.value

describe("makeSpanBuffer captureException", () => {
	it("records a thrown error as an Error span with an exception event", () => {
		const buffer = makeSpanBuffer()
		buffer.captureException(new TypeError("Cannot read properties of undefined (reading 'spans')"))

		const [span] = buffer.drain()
		assert.isDefined(span)
		assert.strictEqual(span?.name, "exception")
		// StatusCode 2 is Error — `error_events_mv` keys off exactly this.
		assert.strictEqual(span?.status.code, 2)

		const event = span?.events.find((candidate) => candidate.name === "exception")
		assert.isDefined(event)
		const attribute = (key: string) => event?.attributes.find((candidate) => candidate.key === key)?.value
		assert.deepStrictEqual(attribute("exception.type"), { stringValue: "TypeError" })
		assert.deepStrictEqual(attribute("exception.message"), {
			stringValue: "Cannot read properties of undefined (reading 'spans')",
		})
	})

	it("carries caller attributes and a custom span name", () => {
		const buffer = makeSpanBuffer()
		buffer.captureException(new Error("boom"), {
			name: "browser.uncaught_error",
			attributes: { "maple.exception.source": "window.onerror" },
		})

		const [span] = buffer.drain()
		assert.strictEqual(span?.name, "browser.uncaught_error")
		assert.deepStrictEqual(attributeOf(span!, "maple.exception.source"), {
			stringValue: "window.onerror",
		})
	})

	it("is not silenceable through anticipatedErrorIdentifiers", () => {
		// An uncaught throw is never an anticipated 4xx. Recording it as a defect
		// keeps it clear of that filter, so a caller cannot accidentally suppress
		// real crashes by listing a tag.
		const buffer = makeSpanBuffer({ anticipatedErrorIdentifiers: new Set(["Error", "TypeError"]) })
		buffer.captureException(new TypeError("still an error"))

		const [span] = buffer.drain()
		assert.strictEqual(span?.status.code, 2)
		assert.isDefined(span?.events.find((candidate) => candidate.name === "exception"))
	})

	it("stays silent while capture is disabled by consent", () => {
		const buffer = makeSpanBuffer()
		buffer.setDisabled(true)
		buffer.captureException(new Error("boom"))
		assert.strictEqual(buffer.size(), 0)
	})
})

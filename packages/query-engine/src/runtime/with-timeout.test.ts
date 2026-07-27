import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Tracer } from "effect"
import { TestClock } from "effect/testing"
import { withTimeout } from "./query-engine"

/**
 * `withTimeout` marks the 30s ceiling with `query.timeout` so a timeout is
 * queryable — the tracer records interrupt-only spans as `Ok`, so without this
 * attribute a full timeout looks healthy in any dashboard keyed on status.
 *
 * The subtlety these tests pin: `Effect.timeoutOrElse` is
 * `raceFirst(self, flatMap(sleep, orElse))`, so `orElse` runs as a SIBLING of
 * `self` — it sees whatever span is current where `withTimeout` was applied,
 * not the span inside it. Wrapping order therefore decides which span gets the
 * attribute, and getting it backwards silently tags the caller instead
 * (production: a query-engine timeout landing on `AlertsService.evaluateRule`).
 */

const makeRecordingTracer = () => {
	const spans: Array<Tracer.NativeSpan> = []
	const tracer = Tracer.make({
		span(options) {
			const span = new Tracer.NativeSpan(options)
			spans.push(span)
			return span
		},
	})
	return { spans, tracer }
}

const timeoutAttr = (spans: Array<Tracer.NativeSpan>, name: string) =>
	spans.find((span) => span.name === name)?.attributes.get("query.timeout") ?? null

describe("withTimeout", () => {
	it.effect("tags the span it is wrapped by, not the caller's span", () => {
		const { spans, tracer } = makeRecordingTracer()
		return Effect.gen(function* () {
			const fiber = yield* Effect.forkChild(
				withTimeout(Effect.never).pipe(
					Effect.withSpan("queryEngine"),
					Effect.withSpan("caller"),
					Effect.exit,
				),
			)
			yield* TestClock.adjust("31 seconds")
			yield* Fiber.join(fiber)

			assert.strictEqual(timeoutAttr(spans, "queryEngine"), true)
			// Regression guard: with `withTimeout` applied OUTSIDE the span instead,
			// this is where the attribute lands.
			assert.strictEqual(timeoutAttr(spans, "caller"), null)
		}).pipe(Effect.provideService(Tracer.Tracer, tracer))
	})

	it.effect("fails with QueryEngineTimeoutError and records timeout_ms", () => {
		const { spans, tracer } = makeRecordingTracer()
		return Effect.gen(function* () {
			const fiber = yield* Effect.forkChild(
				withTimeout(Effect.never).pipe(Effect.withSpan("queryEngine"), Effect.exit),
			)
			yield* TestClock.adjust("31 seconds")
			const exit = yield* Fiber.join(fiber)

			assert.strictEqual(exit._tag, "Failure")
			const span = spans.find((candidate) => candidate.name === "queryEngine")
			assert.strictEqual(span?.attributes.get("query.timeout_ms"), 30_000)
		}).pipe(Effect.provideService(Tracer.Tracer, tracer))
	})

	it.effect("leaves no timeout attribute when the effect completes in time", () => {
		const { spans, tracer } = makeRecordingTracer()
		return Effect.gen(function* () {
			yield* withTimeout(Effect.succeed("ok")).pipe(Effect.withSpan("queryEngine"))
			assert.strictEqual(timeoutAttr(spans, "queryEngine"), null)
		}).pipe(Effect.provideService(Tracer.Tracer, tracer))
	})
})

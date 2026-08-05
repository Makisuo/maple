import { assert, describe, it } from "@effect/vitest"
import { Effect, Tracer } from "effect"
import { updateCurrentSpanName } from "./span-name"

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

describe("updateCurrentSpanName", () => {
	it.effect("renames the span the tracer recorded", () =>
		Effect.gen(function* () {
			const { spans, tracer } = makeRecordingTracer()

			yield* updateCurrentSpanName("SELECT alert_rules").pipe(
				Effect.withSpan("Database.execute"),
				Effect.withTracer(tracer),
			)

			// The tracer holds the same instance we mutated, so the renamed value is
			// what any exporter reads when the span ends. If this ever fails, Effect
			// has started freezing or copying spans — see span-name.ts.
			assert.deepStrictEqual(
				spans.map((span) => span.name),
				["SELECT alert_rules"],
			)
		}),
	)

	it.effect("renames only the innermost span", () =>
		Effect.gen(function* () {
			const { spans, tracer } = makeRecordingTracer()

			yield* updateCurrentSpanName("SELECT actors").pipe(
				Effect.withSpan("Database.execute"),
				Effect.withSpan("ErrorsService.listIssues"),
				Effect.withTracer(tracer),
			)

			assert.deepStrictEqual(spans.map((span) => span.name).sort(), [
				"ErrorsService.listIssues",
				"SELECT actors",
			])
		}),
	)

	it.effect("no-ops without a current span", () =>
		Effect.gen(function* () {
			const { spans, tracer } = makeRecordingTracer()
			yield* updateCurrentSpanName("SELECT actors").pipe(Effect.withTracer(tracer))
			assert.deepStrictEqual(spans, [])
		}),
	)
})

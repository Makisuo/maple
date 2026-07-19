import { afterEach, describe, it } from "@effect/vitest"
import { strict as assert } from "node:assert"
import { Effect, Layer, Tracer } from "effect"
import { Mode } from "./mode"
import { rawQuery } from "./operations"

const realFetch = globalThis.fetch

afterEach(() => {
	globalThis.fetch = realFetch
})

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

describe("rawQuery instrumentation", () => {
	it.effect("emits the canonical chDB Client span", () =>
		Effect.gen(function* () {
			globalThis.fetch = (async () =>
				new Response(JSON.stringify([{ value: 1 }]), {
					status: 200,
					headers: { "content-type": "application/json" },
				})) as unknown as typeof fetch
			const { spans, tracer } = makeRecordingTracer()
			const modeLayer = Layer.succeed(Mode, {
				resolve: Effect.succeed({ _tag: "local" as const, baseUrl: "http://127.0.0.1:4318" }),
			})

			const rows = yield* rawQuery("SELECT 1").pipe(
				Effect.provide(modeLayer),
				Effect.withTracer(tracer),
			)

			assert.deepStrictEqual(rows, [{ value: 1 }])
			const span = spans.find((candidate) => candidate.name === "WarehouseExecutor.rawQuery")
			assert.ok(span)
			assert.strictEqual(span.kind, "client")
			assert.strictEqual(span.attributes.get("db.system.name"), "clickhouse")
			assert.strictEqual(span.attributes.get("peer.service"), "chdb")
			assert.strictEqual(span.attributes.get("query.context"), "cli.rawQuery")
			assert.strictEqual(span.attributes.get("result.rowCount"), 1)
			assert.strictEqual(typeof span.attributes.get("db.duration_ms"), "number")
		}),
	)
})

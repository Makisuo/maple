import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Scope from "effect/Scope"
import { describe, expect, it } from "vitest"
import { WorkerEnvironment } from "./worker-env.ts"
import { requestTelemetryLayer } from "./worker-telemetry.ts"

describe("requestTelemetryLayer", () => {
	it("flushes the SDK buffers with the Worker env once the event scope closes", async () => {
		const flushed: Array<Record<string, unknown>> = []
		const telemetry = {
			layer: Layer.empty,
			flush: async (env: Record<string, unknown>) => {
				flushed.push(env)
			},
		}
		const env = { MAPLE_INGEST_KEY: "maple_sk_test" }
		const layer = requestTelemetryLayer(telemetry).pipe(
			Layer.provide(Layer.succeed(WorkerEnvironment, env)),
		)

		await Effect.runPromise(
			Effect.gen(function* () {
				const scope = yield* Scope.make()
				yield* Layer.buildWithScope(layer, scope)
				expect(flushed).toEqual([])
				yield* Scope.close(scope, Exit.succeed(undefined))
				expect(flushed).toEqual([env])
			}),
		)
	})
})

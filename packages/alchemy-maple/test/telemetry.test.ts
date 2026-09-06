import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Redacted } from "effect"
import * as Output from "alchemy/Output"
import { type BaseRuntimeContext, RuntimeContext } from "alchemy/RuntimeContext"
import { Telemetry } from "../src/Telemetry"

/** A recording host: what the layer binds onto it at plan time. */
const host = () => {
	const bound = new Map<string, Output.Output>()
	const context: BaseRuntimeContext = {
		Type: "Cloudflare.Worker",
		id: "api",
		env: {},
		get: () => Effect.succeed(undefined),
		set: (id, output) => {
			bound.set(id, output)
			return Effect.succeed(id)
		},
	}
	return { bound, context }
}

describe("Maple.Telemetry", () => {
	it.effect(
		"binds the ingest key, endpoint and environment onto the host and registers the SDK layer",
		() =>
			Effect.gen(function* () {
				const { bound, context } = host()
				yield* Layer.build(
					Telemetry({
						serviceName: "api",
						ingestKey: Redacted.make("maple_sk_test"),
						endpoint: "https://ingest.test",
						environment: "staging",
					}),
				).pipe(Effect.provide(Layer.succeed(RuntimeContext, context)))
				assert.deepStrictEqual([...bound.keys()].sort(), [
					"MAPLE_ENDPOINT",
					"MAPLE_ENVIRONMENT",
					"MAPLE_INGEST_KEY",
				])
				assert.isTrue([...bound.values()].every(Output.isOutput))
				assert.isDefined(context.telemetry)
			}).pipe(Effect.scoped),
	)

	it.effect("binds nothing when the env already carries the key, but still registers the layer", () =>
		Effect.gen(function* () {
			const { bound, context } = host()
			yield* Layer.build(Telemetry({ serviceName: "api" })).pipe(
				Effect.provide(Layer.succeed(RuntimeContext, context)),
			)
			assert.strictEqual(bound.size, 0)
			assert.isDefined(context.telemetry)
		}).pipe(Effect.scoped),
	)

	it.effect("builds outside a host (tests, plain runtimes) without touching anything", () =>
		Layer.build(Telemetry({ serviceName: "api", ingestKey: Redacted.make("maple_sk_test") })).pipe(
			Effect.asVoid,
			Effect.scoped,
		),
	)
})

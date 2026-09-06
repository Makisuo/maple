import { assert, describe, it } from "@effect/vitest"
import * as MapleCloudflareSDK from "@maple-dev/effect-sdk/cloudflare"
import { Effect, Exit, Layer, Redacted, Scope } from "effect"
import * as Output from "alchemy/Output"
import {
	type BaseRuntimeContext,
	packEnvValue,
	packEnvValueKeepRedacted,
	RuntimeContext,
} from "alchemy/RuntimeContext"
import { Telemetry, unpackBoundEnv } from "../src/Telemetry"

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

describe("unpackBoundEnv", () => {
	it("unwraps the packed forms alchemy binds and passes direct env values through", () => {
		const secret = packEnvValueKeepRedacted(Redacted.make("maple_sk_bound"))
		assert.deepStrictEqual(
			unpackBoundEnv({
				MAPLE_INGEST_KEY: Redacted.isRedacted(secret) ? Redacted.value(secret) : secret,
				MAPLE_ENDPOINT: packEnvValue("https://ingest.test"),
				MAPLE_ENVIRONMENT: "production",
				OTHER: '{"_tag":"Redacted","value":"untouched"}',
			}),
			{
				MAPLE_INGEST_KEY: "maple_sk_bound",
				MAPLE_ENDPOINT: "https://ingest.test",
				MAPLE_ENVIRONMENT: "production",
				OTHER: '{"_tag":"Redacted","value":"untouched"}',
			},
		)
	})
})

describe("Maple.Telemetry at runtime", () => {
	it.effect("exports with the bound key unwrapped, once the event scope closes", () =>
		Effect.gen(function* () {
			const authorizations: Array<string | null> = []
			const realFetch = globalThis.fetch
			globalThis.fetch = async (input, init) => {
				authorizations.push(new Headers(init?.headers).get("authorization"))
				return new Response(null, { status: 200 })
			}
			yield* Effect.addFinalizer(() =>
				Effect.sync(() => {
					globalThis.fetch = realFetch
				}),
			)

			// Register the layer the way init does, then build what the bridge
			// would build per event — against the env as alchemy deploys it.
			const { context } = host()
			yield* Layer.build(
				Telemetry({ serviceName: "api", ingestKey: Redacted.make("maple_sk_bound") }),
			).pipe(Effect.provide(Layer.succeed(RuntimeContext, context)))
			assert.isDefined(context.telemetry)
			const secret = packEnvValueKeepRedacted(Redacted.make("maple_sk_bound"))
			const env = {
				MAPLE_INGEST_KEY: Redacted.isRedacted(secret) ? Redacted.value(secret) : secret,
				MAPLE_ENDPOINT: "https://ingest.test",
			}
			const event = yield* Scope.make()
			const services = yield* Layer.buildWithScope(
				context.telemetry!.pipe(
					Layer.provide(Layer.succeed(MapleCloudflareSDK.WorkerEnvironment, env)),
				),
				event,
			)
			yield* Effect.succeed(undefined).pipe(Effect.withSpan("op"), Effect.provide(services))
			assert.deepStrictEqual(authorizations, [])
			yield* Scope.close(event, Exit.void)
			assert.deepStrictEqual(authorizations, ["Bearer maple_sk_bound"])
		}).pipe(Effect.scoped),
	)
})

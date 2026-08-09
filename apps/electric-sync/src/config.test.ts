import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Exit, Layer, Option, Redacted } from "effect"
import { SyncConfig } from "./config"

const build = (env: Record<string, string>) =>
	SyncConfig.pipe(
		Effect.provide(
			SyncConfig.layer.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env)))),
		),
		Effect.exit,
	)

const SELF_HOSTED = { MAPLE_ROOT_PASSWORD: "root-password" }

describe("SyncConfig", () => {
	it.effect("reads the Electric upstream and defaults the auth mode to self-hosted", () =>
		Effect.gen(function* () {
			const exit = yield* build({ ...SELF_HOSTED, ELECTRIC_URL: "http://electric:3000" })
			assert.isTrue(Exit.isSuccess(exit))
			if (!Exit.isSuccess(exit)) return
			assert.deepStrictEqual(exit.value.ELECTRIC_URL, Option.some("http://electric:3000"))
			assert.strictEqual(exit.value.MAPLE_AUTH_MODE, "self_hosted")
			assert.strictEqual(exit.value.MAPLE_DEFAULT_ORG_ID, "default")
		}),
	)

	/**
	 * Absent ELECTRIC_URL is not an error — it is the supported self-hosted-without-
	 * Electric deploy, which the proxy turns into a 503 so the web app degrades.
	 */
	it.effect("treats a missing Electric upstream as absent, not fatal", () =>
		Effect.gen(function* () {
			const exit = yield* build(SELF_HOSTED)
			assert.isTrue(Exit.isSuccess(exit))
			if (!Exit.isSuccess(exit)) return
			assert.isTrue(Option.isNone(exit.value.ELECTRIC_URL))
		}),
	)

	it.effect("keeps the Electric secret redacted", () =>
		Effect.gen(function* () {
			const exit = yield* build({
				...SELF_HOSTED,
				ELECTRIC_URL: "http://electric:3000",
				ELECTRIC_SOURCE_ID: "src_1",
				ELECTRIC_SECRET: "sh_secret",
			})
			assert.isTrue(Exit.isSuccess(exit))
			if (!Exit.isSuccess(exit)) return
			assert.deepStrictEqual(
				Option.map(exit.value.ELECTRIC_SECRET, Redacted.value),
				Option.some("sh_secret"),
			)
		}),
	)

	/**
	 * The three fail-fast rules. Each is a defect at layer build rather than a
	 * per-request failure, so a misconfigured deploy breaks loudly at startup
	 * instead of 500ing one request at a time.
	 */
	it.effect("dies when MAPLE_DEFAULT_ORG_ID is blank", () =>
		Effect.gen(function* () {
			const exit = yield* build({ ...SELF_HOSTED, MAPLE_DEFAULT_ORG_ID: "   " })
			assert.isTrue(Exit.isFailure(exit))
		}),
	)

	it.effect("dies without MAPLE_ROOT_PASSWORD in self-hosted mode", () =>
		Effect.gen(function* () {
			const exit = yield* build({ MAPLE_AUTH_MODE: "self_hosted" })
			assert.isTrue(Exit.isFailure(exit))
		}),
	)

	it.effect("dies without CLERK_SECRET_KEY in clerk mode", () =>
		Effect.gen(function* () {
			const exit = yield* build({ MAPLE_AUTH_MODE: "clerk" })
			assert.isTrue(Exit.isFailure(exit))
		}),
	)

	it.effect("accepts clerk mode with its secret, and does not require the root password", () =>
		Effect.gen(function* () {
			const exit = yield* build({ MAPLE_AUTH_MODE: "clerk", CLERK_SECRET_KEY: "sk_test_1" })
			assert.isTrue(Exit.isSuccess(exit))
		}),
	)
})

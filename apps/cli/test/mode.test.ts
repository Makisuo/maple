import { afterEach, describe, it } from "@effect/vitest"
import { Effect, Layer, Option, Redacted } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { match, strictEqual } from "node:assert"
import { MapleConfig, type MapleConfigShape } from "../src/core/config"
import { Mode } from "../src/core/mode"

const originalArgv = process.argv
afterEach(() => {
	process.argv = originalArgv
})

const config = (overrides: Partial<MapleConfigShape> = {}): MapleConfigShape => ({
	apiUrl: undefined,
	token: Option.none(),
	orgId: undefined,
	localUrl: "http://127.0.0.1:4318",
	defaultMode: undefined,
	defaultApiUrl: "https://api.maple.dev",
	lastUpdateCheck: undefined,
	latestKnownVersion: undefined,
	write: () => Effect.void,
	clearToken: () => Effect.void,
	setDefaultMode: () => Effect.void,
	clearDefaultMode: () => Effect.void,
	recordUpdateCheck: () => Effect.void,
	...overrides,
})

const runResolve = (value: MapleConfigShape) =>
	Effect.gen(function* () {
		const mode = yield* Mode
		return yield* mode.resolve
	}).pipe(Effect.provide(Mode.layer.pipe(Layer.provide(Layer.succeed(MapleConfig, value)))))

describe("Mode", () => {
	it.effect("uses redacted remote credentials without probing local mode", () =>
		Effect.gen(function* () {
			process.argv = ["bun", "maple", "services", "--remote"]
			const fetchStub: typeof globalThis.fetch = async () => {
				throw new Error("local probe should not run")
			}

			const resolved = yield* runResolve(
				config({
					apiUrl: "https://api.maple.test",
					token: Option.some(Redacted.make("secret")),
					orgId: "org_test",
				}),
			).pipe(Effect.provideService(FetchHttpClient.Fetch, fetchStub))

			strictEqual(resolved._tag, "remote")
			if (resolved._tag === "remote") {
				strictEqual(resolved.apiUrl, "https://api.maple.test")
				strictEqual(Redacted.value(resolved.token), "secret")
			}
		}),
	)

	it.effect("auto-detects a healthy local backend", () =>
		Effect.gen(function* () {
			process.argv = ["bun", "maple", "services"]
			const fetchStub: typeof globalThis.fetch = async () => new Response(null, { status: 204 })

			const resolved = yield* runResolve(config()).pipe(
				Effect.provideService(FetchHttpClient.Fetch, fetchStub),
			)

			strictEqual(resolved._tag, "local")
			if (resolved._tag === "local") strictEqual(resolved.baseUrl, "http://127.0.0.1:4318")
		}),
	)

	it.live("aborts a stalled local probe when its timeout expires", () =>
		Effect.gen(function* () {
			process.argv = ["bun", "maple", "services"]
			let signal: AbortSignal | undefined
			const fetchStub: typeof globalThis.fetch = (_input, init) =>
				new Promise((_resolve, reject) => {
					signal = init?.signal ?? undefined
					signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))
				})
			const error = yield* runResolve(config()).pipe(
				Effect.provideService(FetchHttpClient.Fetch, fetchStub),
				Effect.flip,
			)

			strictEqual(signal?.aborted, true)
			match(error.message, /No Maple backend found/)
		}),
	)

	it.effect("rejects conflicting mode flags", () =>
		Effect.gen(function* () {
			process.argv = ["bun", "maple", "services", "--remote", "--local"]

			const error = yield* runResolve(config()).pipe(Effect.flip)

			strictEqual(error._tag, "@maple/cli/ModeError")
			match(error.message, /Cannot use --remote and --local together/)
		}),
	)
})

import { describe, expect, it } from "vitest"
import { Effect, Layer, Redacted } from "effect"
import type { ScopedPlanStatusSession } from "alchemy/Cli/Cli"
import { ApiKey, ApiKeyProvider } from "../src/ApiKey"
import { Dashboard, DashboardProvider } from "../src/Dashboard"
import { MapleApi, type MapleApiShape } from "../src/MapleApi"
import { MapleNotFoundError, type MapleError } from "../src/errors"

/** In-memory stub of the v2 API: canned responses + a call log. */
const makeStub = (
	routes: Record<string, (body?: unknown) => Effect.Effect<unknown, MapleError>>,
): { api: MapleApiShape; calls: Array<string> } => {
	const calls: Array<string> = []
	const dispatch = (method: string, path: string, body?: unknown) => {
		calls.push(`${method} ${path}`)
		const handler = routes[`${method} ${path}`]
		if (handler === undefined) {
			return Effect.fail<MapleError>(new MapleNotFoundError({ status: 404, message: `no route: ${method} ${path}` }))
		}
		return handler(body)
	}
	return {
		calls,
		api: {
			get: (path) => dispatch("GET", path),
			post: (path, body) => dispatch("POST", path, body),
			patch: (path, body) => dispatch("PATCH", path, body),
			delete: (path) => dispatch("DELETE", path),
		},
	}
}

const session: ScopedPlanStatusSession = {
	emit: () => Effect.void,
	done: () => Effect.void,
	note: () => Effect.void,
}

const wireDashboard = {
	id: "dash_abc",
	object: "dashboard",
	name: "Service health",
	description: null,
	tags: [],
	time_range: { type: "relative", value: "12h" },
	widgets: [],
	variables: [],
	created_at: "2026-07-01T12:00:00.000Z",
	updated_at: "2026-07-01T12:00:00.000Z",
}

const runWithProvider = <A>(
	api: MapleApiShape,
	program: Effect.Effect<A, unknown, any>,
): Promise<A> =>
	Effect.runPromise(
		program.pipe(
			Effect.provide(DashboardProvider().pipe(Layer.provide(Layer.succeed(MapleApi, api)))),
			Effect.provide(ApiKeyProvider().pipe(Layer.provide(Layer.succeed(MapleApi, api)))),
		) as Effect.Effect<A>,
	)

describe("DashboardProvider", () => {
	it("creates when there is no prior state", async () => {
		const stub = makeStub({
			"POST /v2/dashboards": () => Effect.succeed(wireDashboard),
		})
		const attributes = await runWithProvider(
			stub.api,
			Effect.gen(function* () {
				const provider = yield* Dashboard.Provider
				return yield* provider.reconcile({
					id: "service-health",
					instanceId: "i-1",
					news: { name: "Service health" },
					olds: undefined,
					output: undefined,
					session,
					bindings: [],
				})
			}),
		)
		expect(attributes).toEqual({ dashboardId: "dash_abc", name: "Service health" })
		expect(stub.calls).toEqual(["POST /v2/dashboards"])
	})

	it("observes without mutating when nothing drifted", async () => {
		const stub = makeStub({
			"GET /v2/dashboards/dash_abc": () => Effect.succeed(wireDashboard),
		})
		await runWithProvider(
			stub.api,
			Effect.gen(function* () {
				const provider = yield* Dashboard.Provider
				return yield* provider.reconcile({
					id: "service-health",
					instanceId: "i-1",
					news: { name: "Service health" },
					olds: { name: "Service health" },
					output: { dashboardId: "dash_abc", name: "Service health" },
					session,
					bindings: [],
				})
			}),
		)
		expect(stub.calls).toEqual(["GET /v2/dashboards/dash_abc"])
	})

	it("patches when a declared field drifted", async () => {
		const stub = makeStub({
			"GET /v2/dashboards/dash_abc": () => Effect.succeed(wireDashboard),
			"PATCH /v2/dashboards/dash_abc": (body) =>
				Effect.succeed({ ...wireDashboard, ...(body as object) }),
		})
		const attributes = await runWithProvider(
			stub.api,
			Effect.gen(function* () {
				const provider = yield* Dashboard.Provider
				return yield* provider.reconcile({
					id: "service-health",
					instanceId: "i-1",
					news: { name: "Renamed", tags: ["golden"] },
					olds: { name: "Service health" },
					output: { dashboardId: "dash_abc", name: "Service health" },
					session,
					bindings: [],
				})
			}),
		)
		expect(attributes.name).toBe("Renamed")
		expect(stub.calls).toEqual(["GET /v2/dashboards/dash_abc", "PATCH /v2/dashboards/dash_abc"])
	})

	it("recreates after an out-of-band delete", async () => {
		const stub = makeStub({
			"POST /v2/dashboards": () => Effect.succeed(wireDashboard),
		})
		await runWithProvider(
			stub.api,
			Effect.gen(function* () {
				const provider = yield* Dashboard.Provider
				return yield* provider.reconcile({
					id: "service-health",
					instanceId: "i-1",
					news: { name: "Service health" },
					olds: { name: "Service health" },
					output: { dashboardId: "dash_gone", name: "Service health" },
					session,
					bindings: [],
				})
			}),
		)
		expect(stub.calls).toEqual(["GET /v2/dashboards/dash_gone", "POST /v2/dashboards"])
	})

	it("delete tolerates 404", async () => {
		const stub = makeStub({})
		await runWithProvider(
			stub.api,
			Effect.gen(function* () {
				const provider = yield* Dashboard.Provider
				yield* provider.delete({
					id: "service-health",
					instanceId: "i-1",
					olds: { name: "Service health" },
					output: { dashboardId: "dash_gone", name: "Service health" },
					session,
					bindings: [],
				})
			}),
		)
		expect(stub.calls).toEqual(["DELETE /v2/dashboards/dash_gone"])
	})
})

const wireApiKey = {
	id: "key_abc",
	object: "api_key",
	name: "ci",
	key_prefix: "maple_ak_9f2c",
	revoked: false,
}

describe("ApiKeyProvider", () => {
	it("captures the one-time secret on create", async () => {
		const stub = makeStub({
			"POST /v2/api_keys": () => Effect.succeed({ ...wireApiKey, secret: "maple_ak_secret1" }),
		})
		const attributes = await runWithProvider(
			stub.api,
			Effect.gen(function* () {
				const provider = yield* ApiKey.Provider
				return yield* provider.reconcile({
					id: "ci",
					instanceId: "i-1",
					news: { name: "ci" },
					olds: undefined,
					output: undefined,
					session,
					bindings: [],
				})
			}),
		)
		expect(Redacted.value(attributes.secret)).toBe("maple_ak_secret1")
	})

	it("preserves the stored secret on steady-state reconcile", async () => {
		const stub = makeStub({
			"GET /v2/api_keys/key_abc": () => Effect.succeed(wireApiKey),
		})
		const secret = Redacted.make("maple_ak_secret1")
		const attributes = await runWithProvider(
			stub.api,
			Effect.gen(function* () {
				const provider = yield* ApiKey.Provider
				return yield* provider.reconcile({
					id: "ci",
					instanceId: "i-1",
					news: { name: "ci" },
					olds: { name: "ci" },
					output: { keyId: "key_abc", name: "ci", keyPrefix: "maple_ak_9f2c", secret },
					session,
					bindings: [],
				})
			}),
		)
		expect(Redacted.value(attributes.secret)).toBe("maple_ak_secret1")
		expect(stub.calls).toEqual(["GET /v2/api_keys/key_abc"])
	})

	it("rolls in place when `rotate` is bumped", async () => {
		const stub = makeStub({
			"GET /v2/api_keys/key_abc": () => Effect.succeed(wireApiKey),
			"POST /v2/api_keys/key_abc/roll": () =>
				Effect.succeed({ ...wireApiKey, id: "key_new", secret: "maple_ak_secret2" }),
		})
		const attributes = await runWithProvider(
			stub.api,
			Effect.gen(function* () {
				const provider = yield* ApiKey.Provider
				return yield* provider.reconcile({
					id: "ci",
					instanceId: "i-1",
					news: { name: "ci", rotate: 2 },
					olds: { name: "ci", rotate: 1 },
					output: {
						keyId: "key_abc",
						name: "ci",
						keyPrefix: "maple_ak_9f2c",
						secret: Redacted.make("maple_ak_secret1"),
					},
					session,
					bindings: [],
				})
			}),
		)
		expect(attributes.keyId).toBe("key_new")
		expect(Redacted.value(attributes.secret)).toBe("maple_ak_secret2")
	})

	it("recreates when the key was revoked out-of-band", async () => {
		const stub = makeStub({
			"GET /v2/api_keys/key_abc": () => Effect.succeed({ ...wireApiKey, revoked: true }),
			"POST /v2/api_keys": () => Effect.succeed({ ...wireApiKey, id: "key_new", secret: "maple_ak_secret2" }),
		})
		const attributes = await runWithProvider(
			stub.api,
			Effect.gen(function* () {
				const provider = yield* ApiKey.Provider
				return yield* provider.reconcile({
					id: "ci",
					instanceId: "i-1",
					news: { name: "ci" },
					olds: { name: "ci" },
					output: {
						keyId: "key_abc",
						name: "ci",
						keyPrefix: "maple_ak_9f2c",
						secret: Redacted.make("maple_ak_secret1"),
					},
					session,
					bindings: [],
				})
			}),
		)
		expect(attributes.keyId).toBe("key_new")
	})
})

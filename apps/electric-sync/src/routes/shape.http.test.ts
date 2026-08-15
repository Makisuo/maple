import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { ElectricNotConfigured, ElectricUpstreamError, ElectricUpstreamUnreachable } from "../errors"
import {
	type ElectricCall,
	fixedTenantLayer,
	noTenantLayer,
	okUpstream,
	recordingElectricClient,
	syncRequest,
} from "../test-support"
import { ElectricSyncRouter } from "./shape.http"

/**
 * The handler's own behaviour, with the upstream and the session both replaced by
 * stubs. Everything here was unreachable while `makeResolveTenant` and the real
 * `fetch` were welded into the route — including, most importantly, any request
 * that actually succeeds.
 */
const routes = (options: {
	readonly calls?: Array<ElectricCall>
	readonly respond?: () => ReturnType<Parameters<typeof recordingElectricClient>[0]["respond"]>
	readonly ensureConfigured?: Effect.Effect<void, ElectricNotConfigured>
	readonly orgId?: string
	readonly authenticated?: boolean
}) =>
	ElectricSyncRouter.pipe(
		Layer.provide(
			recordingElectricClient({
				calls: options.calls ?? [],
				respond: options.respond ?? (() => Effect.succeed(okUpstream())),
				...(options.ensureConfigured ? { ensureConfigured: options.ensureConfigured } : undefined),
			}),
		),
		Layer.provide(
			options.authenticated === false ? noTenantLayer : fixedTenantLayer(options.orgId ?? "org_live"),
		),
	)

describe("shape route: a served shape", () => {
	it.effect("returns the upstream body and status", () =>
		Effect.gen(function* () {
			const { status, body } = yield* syncRequest(
				routes({ respond: () => Effect.succeed(okUpstream({ body: `[{"key":"row"}]` })) }),
				"/api/sync/shape?shape=dashboards&offset=-1",
			)
			assert.strictEqual(status, 200)
			assert.strictEqual(body, `[{"key":"row"}]`)
		}),
	)

	/**
	 * The point of the whole proxy, asserted end to end for the first time: the org
	 * the *bearer* resolved to is the org the upstream request is scoped by. Every
	 * previous test could only pass a literal orgId into the URL builder, which
	 * proves the builder works and nothing about the wiring.
	 */
	it.effect("scopes the upstream call to the org the session resolved to", () =>
		Effect.gen(function* () {
			const calls: Array<ElectricCall> = []
			yield* syncRequest(
				routes({ calls, orgId: "org_from_bearer" }),
				"/api/sync/shape?shape=dashboards&offset=-1",
			)

			assert.lengthOf(calls, 1)
			assert.strictEqual(calls[0]?.orgId, "org_from_bearer")
			assert.strictEqual(calls[0]?.request.shape, "dashboards")
		}),
	)

	it.effect("passes a scoped shape's scope value through to the upstream", () =>
		Effect.gen(function* () {
			const calls: Array<ElectricCall> = []
			yield* syncRequest(routes({ calls }), "/api/sync/shape?shape=investigation&scope=inv_1&offset=-1")
			assert.deepStrictEqual(calls[0]?.request.scope, { column: "id", value: "inv_1" })
		}),
	)

	/**
	 * The client-facing URL carries no org — it is byte-identical for every tenant,
	 * with the org derived from the bearer — so a shared cache keyed on it would
	 * serve one org's rows to another. This asserts the isolation survives all the
	 * way out of the handler, not just in the pure header helper.
	 */
	it.effect("cache-isolates the response on the way out", () =>
		Effect.gen(function* () {
			const { headers } = yield* syncRequest(
				routes({
					respond: () =>
						Effect.succeed(
							okUpstream({
								headers: {
									"cache-control": "public, max-age=60",
									"content-length": "14",
									"electric-handle": "h1",
								},
							}),
						),
				}),
				"/api/sync/shape?shape=dashboards&offset=-1",
			)

			assert.strictEqual(headers.get("vary"), "Authorization")
			assert.strictEqual(headers.get("cache-control"), "private, max-age=60")
			// The cursor header must survive, or the client cannot advance.
			assert.strictEqual(headers.get("electric-handle"), "h1")
		}),
	)
})

describe("shape route: rejections", () => {
	it.effect("401s when the session does not resolve to a tenant", () =>
		Effect.gen(function* () {
			const calls: Array<ElectricCall> = []
			const { status, body } = yield* syncRequest(
				routes({ calls, authenticated: false }),
				"/api/sync/shape?shape=dashboards&offset=-1",
			)
			assert.strictEqual(status, 401)
			assert.strictEqual(body, "Unauthorized")
			// An unauthenticated request must never reach Electric.
			assert.lengthOf(calls, 0)
		}),
	)

	it.effect("400s an unknown shape", () =>
		Effect.gen(function* () {
			const { status, body } = yield* syncRequest(routes({}), "/api/sync/shape?shape=users&offset=-1")
			assert.strictEqual(status, 400)
			assert.strictEqual(body, "Unknown or missing shape")
		}),
	)

	it.effect("400s a scoped shape that arrives without a scope", () =>
		Effect.gen(function* () {
			const { status, body } = yield* syncRequest(
				routes({}),
				"/api/sync/shape?shape=investigation&offset=-1",
			)
			assert.strictEqual(status, 400)
			assert.strictEqual(body, "Shape investigation requires a scope")
		}),
	)

	/**
	 * Request validation now runs ahead of the configuration gate, so a 400 means
	 * 400 regardless of how this deploy is configured. Previously an unknown shape
	 * on an unconfigured deploy answered 503, which said "sync is off" about a
	 * request that was never valid in the first place.
	 */
	it.effect("400s an unknown shape even when sync is not configured", () =>
		Effect.gen(function* () {
			const { status } = yield* syncRequest(
				routes({
					ensureConfigured: Effect.fail(
						new ElectricNotConfigured({ message: "no url", reason: "missing_url" }),
					),
				}),
				"/api/sync/shape?shape=users&offset=-1",
			)
			assert.strictEqual(status, 400)
		}),
	)
})

describe("shape route: degradation", () => {
	const notConfigured = (reason: "missing_url" | "incoherent_credentials") =>
		Effect.fail(new ElectricNotConfigured({ message: reason, reason }))

	it.effect("503s when ELECTRIC_URL is absent entirely (self-hosted without Electric)", () =>
		Effect.gen(function* () {
			const { status, body } = yield* syncRequest(
				routes({ ensureConfigured: notConfigured("missing_url") }),
				"/api/sync/shape?shape=dashboards&offset=-1",
			)
			assert.strictEqual(status, 503)
			assert.strictEqual(body, "Electric sync is not configured")
		}),
	)

	it.effect("503s when Cloud credentials are half-configured", () =>
		Effect.gen(function* () {
			const { status, body } = yield* syncRequest(
				routes({ ensureConfigured: notConfigured("incoherent_credentials") }),
				"/api/sync/shape?shape=dashboards&offset=-1",
			)
			assert.strictEqual(status, 503)
			assert.strictEqual(body, "Electric sync is not configured")
		}),
	)

	/**
	 * The gate sits ahead of auth deliberately: an unconfigured deploy answers 503
	 * to everyone. The web app's collections watch for that to degrade to their
	 * effect-atom fetches, and a 401 here would leave an unauthenticated client
	 * unable to tell "sync is off" from "your session expired".
	 */
	it.effect("503s before authenticating, so an unauthenticated client still sees degradation", () =>
		Effect.gen(function* () {
			const { status } = yield* syncRequest(
				routes({ authenticated: false, ensureConfigured: notConfigured("missing_url") }),
				"/api/sync/shape?shape=dashboards&offset=-1",
			)
			assert.strictEqual(status, 503)
		}),
	)
})

describe("shape route: upstream failures", () => {
	it.effect("502s when Electric is unreachable", () =>
		Effect.gen(function* () {
			const { status, body } = yield* syncRequest(
				routes({
					respond: () => Effect.fail(new ElectricUpstreamUnreachable({ message: "ECONNREFUSED" })),
				}),
				"/api/sync/shape?shape=dashboards&offset=-1",
			)
			assert.strictEqual(status, 502)
			assert.strictEqual(body, "Electric upstream unreachable")
		}),
	)

	it.effect("passes an upstream 5xx through with its status and body", () =>
		Effect.gen(function* () {
			const { status, body, headers } = yield* syncRequest(
				routes({
					respond: () =>
						Effect.fail(
							new ElectricUpstreamError({
								message: "Electric returned 503",
								status: 503,
								body: "electric exploded",
								headers: { "cache-control": "public, max-age=60" },
							}),
						),
				}),
				"/api/sync/shape?shape=dashboards&offset=-1",
			)
			assert.strictEqual(status, 503)
			assert.strictEqual(body, "electric exploded")
			// An error response is org-scoped too and must not be shared-cached.
			assert.strictEqual(headers.get("cache-control"), "private, max-age=60")
		}),
	)
})

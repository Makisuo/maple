/**
 * Integration test for the `@maple-dev/alchemy` provider package
 * (`lib/alchemy-maple`): drives the real provider lifecycle functions
 * (reconcile / read / delete) through the real v2 handlers over PGlite,
 * with the package's own HTTP client routed at the in-process web handler
 * via a custom `fetch`.
 */
import { afterEach, describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Context, Effect, Layer, ManagedRuntime, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { OrgId, UserId } from "@maple/domain/http"
import { MapleApiV2 } from "@maple/domain/http/v2"
import { BucketCacheService, EdgeCacheService } from "@maple/query-engine/caching"
import type { ScopedPlanStatusSession } from "alchemy/Cli/Cli"
import { AlertDestination, AlertDestinationProvider } from "../../../../../lib/alchemy-maple/src/AlertDestination.ts"
import { AlertRule, AlertRuleProvider } from "../../../../../lib/alchemy-maple/src/AlertRule.ts"
import { ApiKey, ApiKeyProvider } from "../../../../../lib/alchemy-maple/src/ApiKey.ts"
import { Dashboard, DashboardProvider } from "../../../../../lib/alchemy-maple/src/Dashboard.ts"
import { make as makeMapleApi, MapleApi } from "../../../../../lib/alchemy-maple/src/MapleApi.ts"
import { MapleEnvironment } from "../../../../../lib/alchemy-maple/src/MapleEnvironment.ts"
import { CacheBackendLive } from "../../lib/CacheBackendLive"
import { EmailService } from "../../lib/EmailService"
import { Env } from "../../lib/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "../../lib/test-pglite"
import type { WarehouseQueryServiceShape } from "../../lib/WarehouseQueryService"
import { WarehouseQueryService } from "../../lib/WarehouseQueryService"
import { ApiAuthorizationV2Layer } from "../../services/ApiAuthorizationV2Layer"
import { ApiKeysService } from "../../services/ApiKeysService"
import { AuthService } from "../../services/AuthService"
import { DashboardPersistenceService } from "../../services/DashboardPersistenceService"
import { AlertRuntime, AlertsService } from "../../services/AlertsService"
import { HazelOAuthService } from "../../services/HazelOAuthService"
import { OrgMembersService } from "../../services/OrgMembersService"
import { QueryEngineService } from "../../services/QueryEngineService"
import { V2SchemaErrorsLive } from "./error-envelope"
import {
	AllV2GroupLayersLive,
	ApiV2RateLimiterAllowAllLayer,
	ConfigResourceServiceStubsLayer,
	TelemetryServiceStubsLayer,
} from "./v2-test-support"

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const testConfig = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3486",
			MCP_PORT: "3487",
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
			MAPLE_APP_BASE_URL: "http://127.0.0.1:3471",
			INTERNAL_SERVICE_TOKEN: "test-internal-token",
			QE_EVAL_BUCKET_CACHE_ENABLED: "false",
		}),
	)

/** The v2 CRUD endpoints exercised here never reach the warehouse. */
const warehouseStub: WarehouseQueryServiceShape = {
	query: () => Effect.die(new Error("unexpected warehouse pipe query")),
	sqlQuery: () => Effect.succeed([]),
	rawSqlQuery: () => Effect.succeed([]),
	compiledQuery: (_tenant, compiled) => compiled.decodeRows([]).pipe(Effect.orDie),
	compiledQueryFirst: () => Effect.die(new Error("unexpected compiled query")),
	ingest: () => Effect.void,
	asExecutor: () => {
		throw new Error("asExecutor is not supported by this test stub")
	},
}

const session: ScopedPlanStatusSession = {
	emit: () => Effect.void,
	done: () => Effect.void,
	note: () => Effect.void,
}

const makeHarness = () => {
	const testDb = createTestDb(createdDbs)
	const configLive = testConfig()
	const envLive = Env.layer.pipe(Layer.provide(configLive))
	const warehouseLive = Layer.succeed(WarehouseQueryService, warehouseStub)
	const edgeCacheLive = EdgeCacheService.layer.pipe(Layer.provide(CacheBackendLive))
	const bucketCacheLive = BucketCacheService.layer.pipe(Layer.provide(edgeCacheLive))
	const queryEngineLive = QueryEngineService.layer.pipe(
		Layer.provide(warehouseLive),
		Layer.provide(edgeCacheLive),
		Layer.provide(bucketCacheLive),
		Layer.provide(configLive),
	)
	const runtimeLive = Layer.succeed(AlertRuntime, {
		now: Effect.sync(() => Date.now()),
		makeUuid: () => crypto.randomUUID(),
		fetch: globalThis.fetch,
		deliveryTimeoutMs: () => 15_000,
	})
	const hazelOAuthLive = HazelOAuthService.layer.pipe(Layer.provide(Layer.mergeAll(envLive, testDb.layer)))
	const emailLive = Layer.succeed(EmailService, {
		isConfigured: false,
		send: () => Effect.void,
	})
	const orgMembersLive = Layer.succeed(OrgMembersService, {
		resolveMembers: () => Effect.succeed([]),
	})
	const alertsLive = AlertsService.layer.pipe(
		Layer.provide(
			Layer.mergeAll(
				envLive,
				testDb.layer,
				queryEngineLive,
				warehouseLive,
				runtimeLive,
				hazelOAuthLive,
				emailLive,
				orgMembersLive,
			),
		),
	)
	const servicesLive = Layer.mergeAll(
		ApiKeysService.layer,
		AuthService.layer,
		DashboardPersistenceService.layer,
		alertsLive,
	).pipe(Layer.provideMerge(Layer.mergeAll(envLive, testDb.layer)))

	const routes = HttpApiBuilder.layer(MapleApiV2).pipe(
		Layer.provide(AllV2GroupLayersLive),
		Layer.provide(ConfigResourceServiceStubsLayer),
		Layer.provide(TelemetryServiceStubsLayer),
		Layer.provide(V2SchemaErrorsLive),
		Layer.provideMerge(ApiAuthorizationV2Layer),
		Layer.provideMerge(ApiV2RateLimiterAllowAllLayer),
		Layer.provideMerge(servicesLive),
	)
	const { handler, dispose: disposeHandler } = HttpRouter.toWebHandler(routes, {
		disableLogger: true,
	})
	const runtime = ManagedRuntime.make(servicesLive)
	const ORG = Schema.decodeUnknownSync(OrgId)("org_alchemy_e2e")
	const USER = Schema.decodeUnknownSync(UserId)("user_alchemy_e2e")

	const bootstrapKey = () =>
		runtime.runPromise(
			Effect.gen(function* () {
				const service = yield* ApiKeysService
				// No scopes = legacy full access; API-key tenants carry the root role.
				return yield* service.create(ORG, USER, { name: "alchemy-provider-test" })
			}),
		)

	/** Route the provider package's HTTP client at the in-process handler. */
	const providerLayers = (secret: string) => {
		const fetchToHandler = ((input: RequestInfo | URL, init?: RequestInit) =>
			handler(new Request(input, init), Context.empty() as never)) as typeof globalThis.fetch
		const clientLive = Layer.effect(MapleApi, makeMapleApi).pipe(
			Layer.provide(FetchHttpClient.layer),
			Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchToHandler)),
			Layer.provide(
				Layer.succeed(MapleEnvironment, {
					baseUrl: "http://maple.test",
					apiKey: Redacted.make(secret),
				}),
			),
		)
		return Layer.mergeAll(
			DashboardProvider(),
			AlertDestinationProvider(),
			AlertRuleProvider(),
			ApiKeyProvider(),
		).pipe(Layer.provideMerge(clientLive))
	}

	return {
		bootstrapKey,
		providerLayers,
		dispose: async () => {
			await disposeHandler()
			await runtime.dispose()
		},
	}
}

describe("@maple-dev/alchemy providers against the real v2 handlers", () => {
	it("runs the full dashboard lifecycle: create → noop → drift patch → delete", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey()
		const layers = harness.providerLayers(key.secret)

		await Effect.runPromise(
			Effect.gen(function* () {
				const provider = yield* Dashboard.Provider

				// Create.
				const created = yield* provider.reconcile({
					id: "ops",
					instanceId: "i-1",
					news: { name: "Operations", tags: ["production"] },
					olds: undefined,
					output: undefined,
					session,
					bindings: [],
				})
				expect(created.dashboardId).toMatch(/^dash_/)

				// Steady state: no drift, no mutation (updated name unchanged).
				const steady = yield* provider.reconcile({
					id: "ops",
					instanceId: "i-1",
					news: { name: "Operations", tags: ["production"] },
					olds: { name: "Operations", tags: ["production"] },
					output: created,
					session,
					bindings: [],
				})
				expect(steady.dashboardId).toBe(created.dashboardId)

				// Drift: rename via PATCH, id stable.
				const renamed = yield* provider.reconcile({
					id: "ops",
					instanceId: "i-1",
					news: { name: "Operations v2", tags: ["production"] },
					olds: { name: "Operations", tags: ["production"] },
					output: created,
					session,
					bindings: [],
				})
				expect(renamed.dashboardId).toBe(created.dashboardId)
				expect(renamed.name).toBe("Operations v2")

				// Read observes the renamed dashboard.
				const observed = yield* provider.read!({
					id: "ops",
					instanceId: "i-1",
					olds: { name: "Operations v2" },
					output: renamed,
				})
				expect(observed?.name).toBe("Operations v2")

				// Delete, then read sees nothing; second delete tolerates the 404.
				yield* provider.delete({
					id: "ops",
					instanceId: "i-1",
					olds: { name: "Operations v2" },
					output: renamed,
					session,
					bindings: [],
				})
				const gone = yield* provider.read!({
					id: "ops",
					instanceId: "i-1",
					olds: { name: "Operations v2" },
					output: renamed,
				})
				expect(gone).toBeUndefined()
				yield* provider.delete({
					id: "ops",
					instanceId: "i-1",
					olds: { name: "Operations v2" },
					output: renamed,
					session,
					bindings: [],
				})
			}).pipe(Effect.provide(layers)) as Effect.Effect<void>,
		)
		await harness.dispose()
	})

	it("wires destination → rule, adopts rules by unique name, and deletes cleanly", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey()
		const layers = harness.providerLayers(key.secret)

		await Effect.runPromise(
			Effect.gen(function* () {
				const destinations = yield* AlertDestination.Provider
				const rules = yield* AlertRule.Provider

				const dest = yield* destinations.reconcile({
					id: "hook",
					instanceId: "i-1",
					news: { type: "webhook", name: "Ops hook", url: "https://example.com/hooks/maple" },
					olds: undefined,
					output: undefined,
					session,
					bindings: [],
				})
				expect(dest.destinationId).toMatch(/^dest_/)

				const ruleProps = {
					name: "Checkout error rate",
					severity: "critical" as const,
					signal_type: "error_rate" as const,
					comparator: "gt" as const,
					threshold: 0.05,
					window_minutes: 5,
					destination_ids: [dest.destinationId],
				}
				const rule = yield* rules.reconcile({
					id: "checkout-errors",
					instanceId: "i-1",
					news: ruleProps,
					olds: undefined,
					output: undefined,
					session,
					bindings: [],
				})
				expect(rule.ruleId).toMatch(/^alrt_/)

				// Lost state (output undefined) → adopted by org-unique name, not duplicated.
				const adopted = yield* rules.reconcile({
					id: "checkout-errors",
					instanceId: "i-1",
					news: ruleProps,
					olds: undefined,
					output: undefined,
					session,
					bindings: [],
				})
				expect(adopted.ruleId).toBe(rule.ruleId)

				// Update threshold via PATCH.
				const updated = yield* rules.reconcile({
					id: "checkout-errors",
					instanceId: "i-1",
					news: { ...ruleProps, threshold: 0.1 },
					olds: ruleProps,
					output: rule,
					session,
					bindings: [],
				})
				expect(updated.ruleId).toBe(rule.ruleId)

				// Delete rule first (destination delete conflicts while referenced).
				yield* rules.delete({
					id: "checkout-errors",
					instanceId: "i-1",
					olds: ruleProps,
					output: updated,
					session,
					bindings: [],
				})
				yield* destinations.delete({
					id: "hook",
					instanceId: "i-1",
					news: undefined,
					olds: { type: "webhook", name: "Ops hook", url: "https://example.com/hooks/maple" },
					output: dest,
					session,
					bindings: [],
				})
				const goneRules = yield* rules.list()
				expect(goneRules).toHaveLength(0)
			}).pipe(Effect.provide(layers)) as Effect.Effect<void>,
		)
		await harness.dispose()
	})

	it("creates an API key with a one-time secret, preserves it, rolls, and revokes", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey()
		const layers = harness.providerLayers(key.secret)

		await Effect.runPromise(
			Effect.gen(function* () {
				const provider = yield* ApiKey.Provider

				const created = yield* provider.reconcile({
					id: "ci",
					instanceId: "i-1",
					news: { name: "ci-pipeline", scopes: ["dashboards:write"] },
					olds: undefined,
					output: undefined,
					session,
					bindings: [],
				})
				expect(created.keyId).toMatch(/^key_/)
				expect(Redacted.value(created.secret)).toMatch(/^maple_ak_/)

				// Steady state preserves the secret (the API never returns it again).
				const steady = yield* provider.reconcile({
					id: "ci",
					instanceId: "i-1",
					news: { name: "ci-pipeline", scopes: ["dashboards:write"] },
					olds: { name: "ci-pipeline", scopes: ["dashboards:write"] },
					output: created,
					session,
					bindings: [],
				})
				expect(steady.keyId).toBe(created.keyId)
				expect(Redacted.value(steady.secret)).toBe(Redacted.value(created.secret))

				// Rotate bump → roll: new id + secret, same name.
				const rolled = yield* provider.reconcile({
					id: "ci",
					instanceId: "i-1",
					news: { name: "ci-pipeline", scopes: ["dashboards:write"], rotate: 1 },
					olds: { name: "ci-pipeline", scopes: ["dashboards:write"] },
					output: steady,
					session,
					bindings: [],
				})
				expect(rolled.keyId).not.toBe(created.keyId)
				expect(Redacted.value(rolled.secret)).not.toBe(Redacted.value(created.secret))
				expect(rolled.name).toBe("ci-pipeline")

				// Revoke; read reports it gone.
				yield* provider.delete({
					id: "ci",
					instanceId: "i-1",
					olds: { name: "ci-pipeline", scopes: ["dashboards:write"], rotate: 1 },
					output: rolled,
					session,
					bindings: [],
				})
				const gone = yield* provider.read!({
					id: "ci",
					instanceId: "i-1",
					olds: { name: "ci-pipeline", scopes: ["dashboards:write"], rotate: 1 },
					output: rolled,
				})
				expect(gone).toBeUndefined()
			}).pipe(Effect.provide(layers)) as Effect.Effect<void>,
		)
		await harness.dispose()
	})
})

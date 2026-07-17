import { afterEach, describe, expect, it } from "vitest"
import { ConfigProvider, Context, Effect, Layer, ManagedRuntime, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { OrgId, UserId } from "@maple/domain/http"
import { MapleApiV2 } from "@maple/domain/http/v2"
import { BucketCacheService, EdgeCacheService } from "@maple/query-engine/caching"
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
import { AllV2GroupLayersLive } from "./v2-test-support"

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const testConfig = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3480",
			MCP_PORT: "3481",
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

/** The v2 alert CRUD endpoints never reach the warehouse; stub it inert. */
const warehouseStub: WarehouseQueryServiceShape = {
	query: () => Effect.die(new Error("unexpected warehouse pipe query")),
	sqlQuery: () => Effect.succeed([]),
	compiledQuery: (_tenant, compiled) => compiled.decodeRows([]).pipe(Effect.orDie),
	compiledQueryFirst: () => Effect.die(new Error("unexpected compiled query")),
	ingest: () => Effect.void,
	asExecutor: () => {
		throw new Error("asExecutor is not supported by this test stub")
	},
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
	const hazelOAuthLive = HazelOAuthService.layer.pipe(
		Layer.provide(Layer.mergeAll(envLive, testDb.layer)),
	)
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
		Layer.provide(V2SchemaErrorsLive),
		Layer.provideMerge(ApiAuthorizationV2Layer),
		Layer.provideMerge(servicesLive),
	)
	const { handler, dispose: disposeHandler } = HttpRouter.toWebHandler(routes, {
		disableLogger: true,
	})
	const runtime = ManagedRuntime.make(servicesLive)
	const ORG = Schema.decodeUnknownSync(OrgId)("org_alerts_e2e")
	const USER = Schema.decodeUnknownSync(UserId)("user_alerts_e2e")

	const bootstrapKey = (scopes?: ReadonlyArray<string>) =>
		runtime.runPromise(
			Effect.gen(function* () {
				const service = yield* ApiKeysService
				return yield* service.create(ORG, USER, { name: "alerts-test", scopes })
			}),
		)

	const request = async (method: string, path: string, token: string, body?: unknown) => {
		const response = await handler(
			new Request(`http://maple.test${path}`, {
				method,
				headers: {
					authorization: `Bearer ${token}`,
					...(body !== undefined ? { "content-type": "application/json" } : {}),
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			}),
			Context.empty() as never,
		)
		const text = await response.text()
		return { status: response.status, body: text.length === 0 ? null : JSON.parse(text) }
	}

	return {
		bootstrapKey,
		request,
		dispose: async () => {
			await disposeHandler()
			await runtime.dispose()
		},
	}
}

describe("v2 alerts over HTTP", () => {
	it("supports destination + rule CRUD with v2 wire conventions", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey([
			"alert_rules:write",
			"alert_destinations:write",
			"alert_incidents:read",
		])

		const destCreated = await harness.request("POST", "/v2/alert_destinations", key.secret, {
			type: "webhook",
			name: "Ops hook",
			url: "https://example.com/hooks/maple",
		})
		expect(destCreated.status).toBe(200)
		expect(destCreated.body.object).toBe("alert_destination")
		expect(destCreated.body.id).toMatch(/^dest_/)
		expect(destCreated.body.type).toBe("webhook")
		// Secrets never round-trip: only the redacted summary comes back.
		expect(JSON.stringify(destCreated.body)).not.toContain("signing")
		expect("url" in destCreated.body).toBe(false)

		const destId: string = destCreated.body.id

		const ruleCreated = await harness.request("POST", "/v2/alert_rules", key.secret, {
			name: "Checkout error rate",
			severity: "critical",
			signal_type: "error_rate",
			comparator: "gt",
			threshold: 0.05,
			window_minutes: 5,
			destination_ids: [destId],
			tags: ["payments"],
		})
		expect(ruleCreated.status).toBe(200)
		expect(ruleCreated.body.object).toBe("alert_rule")
		expect(ruleCreated.body.id).toMatch(/^alrt_/)
		expect(ruleCreated.body.destination_ids).toEqual([destId])
		expect(ruleCreated.body.no_data_behavior).toBe("skip")
		expect(ruleCreated.body.txid).toMatch(/^\d+$/)
		expect("signalType" in ruleCreated.body).toBe(false)

		const ruleId: string = ruleCreated.body.id

		const listed = await harness.request("GET", "/v2/alert_rules?limit=1", key.secret)
		expect(listed.status).toBe(200)
		expect(listed.body).toMatchObject({ object: "list", has_more: false, next_cursor: null })
		expect(listed.body.data[0].id).toBe(ruleId)
		expect("txid" in listed.body.data[0]).toBe(false)

		const retrieved = await harness.request("GET", `/v2/alert_rules/${ruleId}`, key.secret)
		expect(retrieved.status).toBe(200)
		expect(retrieved.body.name).toBe("Checkout error rate")

		// PATCH is a true partial update: pausing the rule keeps the condition.
		const patched = await harness.request("PATCH", `/v2/alert_rules/${ruleId}`, key.secret, {
			enabled: false,
		})
		expect(patched.status).toBe(200)
		expect(patched.body.enabled).toBe(false)
		expect(patched.body.threshold).toBe(0.05)
		expect(patched.body.tags).toEqual(["payments"])
		expect(patched.body.txid).toMatch(/^\d+$/)

		const checks = await harness.request("GET", `/v2/alert_rules/${ruleId}/checks`, key.secret)
		expect(checks.status).toBe(200)
		expect(checks.body).toMatchObject({ object: "list", data: [], has_more: false })

		const incidents = await harness.request("GET", "/v2/alert_incidents", key.secret)
		expect(incidents.status).toBe(200)
		expect(incidents.body).toMatchObject({ object: "list", data: [] })

		// A destination referenced by a rule cannot be deleted.
		const conflicted = await harness.request("DELETE", `/v2/alert_destinations/${destId}`, key.secret)
		expect(conflicted.status).toBe(409)
		expect(conflicted.body.error).toMatchObject({ type: "conflict_error", code: "resource_in_use" })

		const ruleDeleted = await harness.request("DELETE", `/v2/alert_rules/${ruleId}`, key.secret)
		expect(ruleDeleted.status).toBe(200)
		expect(ruleDeleted.body).toMatchObject({ id: ruleId, object: "alert_rule", deleted: true })

		const destDeleted = await harness.request("DELETE", `/v2/alert_destinations/${destId}`, key.secret)
		expect(destDeleted.status).toBe(200)
		expect(destDeleted.body).toMatchObject({ id: destId, object: "alert_destination", deleted: true })

		const missing = await harness.request("GET", `/v2/alert_rules/${ruleId}`, key.secret)
		expect(missing.status).toBe(404)
		expect(missing.body.error).toMatchObject({ type: "not_found_error", code: "resource_missing" })

		await harness.dispose()
	})

	it("enforces per-family scopes and rejects malformed ids", async () => {
		const harness = makeHarness()
		const readOnly = await harness.bootstrapKey(["alert_rules:read"])

		const list = await harness.request("GET", "/v2/alert_rules", readOnly.secret)
		expect(list.status).toBe(200)

		const create = await harness.request("POST", "/v2/alert_rules", readOnly.secret, {
			name: "Denied",
			severity: "warning",
			signal_type: "error_rate",
			comparator: "gt",
			threshold: 0.5,
			window_minutes: 5,
			destination_ids: [],
		})
		expect(create.status).toBe(403)
		expect(create.body.error).toMatchObject({ type: "permission_error", code: "insufficient_scope" })

		// Scope families are independent: alert_rules:read grants nothing on destinations.
		const destinations = await harness.request("GET", "/v2/alert_destinations", readOnly.secret)
		expect(destinations.status).toBe(403)
		expect(destinations.body.error).toMatchObject({ type: "permission_error", code: "insufficient_scope" })

		const malformed = await harness.request("GET", "/v2/alert_rules/dash_notARuleId", readOnly.secret)
		expect(malformed.status).toBe(400)
		expect(malformed.body.error).toMatchObject({ type: "invalid_request_error" })

		await harness.dispose()
	})
})

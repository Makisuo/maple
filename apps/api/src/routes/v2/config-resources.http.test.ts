import { afterEach, describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Context, Effect, Layer, ManagedRuntime, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { OrgId, ScrapeTargetId, UserId } from "@maple/domain/http"
import { decodePublicId, MapleApiV2 } from "@maple/domain/http/v2"
import { cleanupTestDbs, createTestDb, type TestDb } from "../../lib/test-pglite"
import type { WarehouseQueryServiceShape } from "../../lib/WarehouseQueryService"
import { WarehouseQueryService } from "../../lib/WarehouseQueryService"
import { Env } from "../../lib/Env"
import { ApiAuthorizationV2Layer } from "../../services/ApiAuthorizationV2Layer"
import { ApiKeysService } from "../../services/ApiKeysService"
import { AuthService } from "../../services/AuthService"
import { DashboardPersistenceService } from "../../services/DashboardPersistenceService"
import { IngestAttributeMappingService } from "../../services/IngestAttributeMappingService"
import { OrgIngestKeysService } from "../../services/OrgIngestKeysService"
import { PlanetScaleDiscoveryService } from "../../services/PlanetScaleDiscoveryService"
import { PlanetScaleOAuthService } from "../../services/PlanetScaleOAuthService"
import { RecommendationIssueService } from "../../services/RecommendationIssueService"
import { ScrapeTargetsService } from "../../services/ScrapeTargetsService"
import { V2SchemaErrorsLive } from "./error-envelope"
import { AlertsServiceStubLayer, AllV2GroupLayersLive, Phase1ResourceStubsLayer } from "./v2-test-support"

/**
 * End-to-end HTTP tests for the v2 config-resource bundle (attribute_mappings,
 * recommendations, ingest_keys, scrape_targets) over an embedded PGlite,
 * exercised with fetch Requests exactly as a client would.
 */

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const testConfig = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3482",
			MCP_PORT: "3483",
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
			INTERNAL_SERVICE_TOKEN: "test-internal-token",
		}),
	)

const die = () => Effect.die(new Error("not available in this test harness"))

/** Recommendations reconcile against the warehouse; an empty read is a valid state. */
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

/** PlanetScale integrations are only reached by `planetscale` targets. */
const planetScaleStubs = Layer.mergeAll(
	Layer.succeed(PlanetScaleDiscoveryService, {
		discover: die,
		lastError: () => Effect.succeed(null),
		invalidate: () => Effect.void,
	}),
	Layer.succeed(PlanetScaleOAuthService, {
		startConnect: die,
		completeConnect: die,
		getValidAccessToken: die,
		listOrganizations: die,
		hasConnection: die,
		connectedByUserId: die,
		disconnect: die,
	}),
)

const makeHarness = () => {
	const testDb = createTestDb(createdDbs)
	const envLive = Env.layer.pipe(Layer.provide(testConfig()))
	const warehouseLive = Layer.succeed(WarehouseQueryService, warehouseStub)
	const scrapeTargetsLive = ScrapeTargetsService.layer.pipe(Layer.provide(planetScaleStubs))
	const servicesLive = Layer.mergeAll(
		ApiKeysService.layer,
		AuthService.layer,
		DashboardPersistenceService.layer,
		IngestAttributeMappingService.layer,
		OrgIngestKeysService.layer,
		RecommendationIssueService.layer.pipe(Layer.provide(warehouseLive)),
		scrapeTargetsLive,
	).pipe(Layer.provideMerge(Layer.mergeAll(envLive, testDb.layer)))

	const routes = HttpApiBuilder.layer(MapleApiV2).pipe(
		Layer.provide(AllV2GroupLayersLive),
		Layer.provide(V2SchemaErrorsLive),
		Layer.provide(AlertsServiceStubLayer),
		Layer.provide(Phase1ResourceStubsLayer),
		// session_replays (in AllV2GroupLayersLive) needs the warehouse at the routes level.
		Layer.provide(warehouseLive),
		Layer.provideMerge(ApiAuthorizationV2Layer),
		Layer.provideMerge(servicesLive),
	)

	const { handler, dispose: disposeHandler } = HttpRouter.toWebHandler(routes, {
		disableLogger: true,
	})
	const runtime = ManagedRuntime.make(servicesLive)

	const request = async (
		method: string,
		path: string,
		options: { token?: string; body?: unknown } = {},
	) => {
		const response = await handler(
			new Request(`http://maple.test${path}`, {
				method,
				headers: {
					...(options.token !== undefined ? { authorization: `Bearer ${options.token}` } : {}),
					...(options.body !== undefined ? { "content-type": "application/json" } : {}),
				},
				body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
			}),
			Context.empty() as never,
		)
		const text = await response.text()
		return { status: response.status, body: text.length > 0 ? JSON.parse(text) : null }
	}

	const ORG = Schema.decodeUnknownSync(OrgId)("org_config_e2e")
	const USER = Schema.decodeUnknownSync(UserId)("user_config_e2e")

	const bootstrapKey = (scopes?: ReadonlyArray<string>) =>
		runtime.runPromise(
			Effect.gen(function* () {
				const service = yield* ApiKeysService
				return yield* service.create(ORG, USER, { name: "config-test", scopes })
			}),
		)
	const seedScrapeChecks = (publicId: string, count: number) => {
		const internalId = decodePublicId("scrp", publicId)
		if (internalId === null) throw new Error(`Invalid scrape target public ID: ${publicId}`)
		const targetId = Schema.decodeUnknownSync(ScrapeTargetId)(internalId)
		const now = Date.now()
		return runtime.runPromise(
			Effect.gen(function* () {
				const service = yield* ScrapeTargetsService
				yield* service.recordScrapeResults(
					Array.from({ length: count }, (_, index) => ({
						targetId,
						scrapedAt: now - index * 1_000,
						error: null,
						durationMs: index,
					})),
				)
			}),
		)
	}

	return {
		request,
		bootstrapKey,
		seedScrapeChecks,
		dispose: async () => {
			await disposeHandler()
			await runtime.dispose()
		},
	}
}

describe("v2 attribute_mappings over HTTP", () => {
	it("full CRUD round-trip with wire shapes", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey()

		const created = await harness.request("POST", "/v2/attribute_mappings", {
			token: key.secret,
			body: {
				name: "Promote team label",
				source_context: "resource",
				source_key: "labels.team",
				target_key: "team",
				operation: "copy",
			},
		})
		expect(created.status).toBe(200)
		expect(created.body.object).toBe("attribute_mapping")
		expect(created.body.id.startsWith("amap_")).toBe(true)
		expect(created.body.source_context).toBe("resource")
		expect(created.body.enabled).toBe(true)
		expect(typeof created.body.created_at).toBe("string")

		const list = await harness.request("GET", "/v2/attribute_mappings", { token: key.secret })
		expect(list.status).toBe(200)
		expect(list.body.object).toBe("list")
		expect(list.body.data).toHaveLength(1)
		expect(list.body.next_cursor).toBeNull()

		const retrieved = await harness.request("GET", `/v2/attribute_mappings/${created.body.id}`, {
			token: key.secret,
		})
		expect(retrieved.status).toBe(200)
		expect(retrieved.body.id).toBe(created.body.id)

		const updated = await harness.request("PATCH", `/v2/attribute_mappings/${created.body.id}`, {
			token: key.secret,
			body: { enabled: false },
		})
		expect(updated.status).toBe(200)
		expect(updated.body.enabled).toBe(false)

		const deleted = await harness.request("DELETE", `/v2/attribute_mappings/${created.body.id}`, {
			token: key.secret,
		})
		expect(deleted.status).toBe(200)
		expect(deleted.body).toEqual({
			id: created.body.id,
			object: "attribute_mapping",
			deleted: true,
		})

		const afterDelete = await harness.request("GET", "/v2/attribute_mappings", { token: key.secret })
		expect(afterDelete.body.data).toHaveLength(0)
		await harness.dispose()
	})

	it("maps a malformed public ID to invalid_request_error and a missing one to not_found_error", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey()

		const badPrefix = await harness.request("GET", "/v2/attribute_mappings/dash_notAmap123", {
			token: key.secret,
		})
		expect(badPrefix.status).toBe(400)
		expect(badPrefix.body.error.type).toBe("invalid_request_error")

		const missing = await harness.request(
			"PATCH",
			// Valid amap_… encoding of a UUID that doesn't exist.
			"/v2/attribute_mappings/amap_YofPTrK9782DWwcnXhpcCw",
			{ token: key.secret, body: { enabled: false } },
		)
		expect(missing.status).toBe(404)
		expect(missing.body.error.type).toBe("not_found_error")
		expect(missing.body.error.code).toBe("attribute_mapping_not_found")
		await harness.dispose()
	})
})

describe("v2 ingest_keys over HTTP", () => {
	it("retrieves (creating on first access) and rolls both keys", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey()

		const initial = await harness.request("GET", "/v2/ingest_keys", { token: key.secret })
		expect(initial.status).toBe(200)
		expect(initial.body.object).toBe("ingest_keys")
		expect(typeof initial.body.public_key).toBe("string")
		expect(typeof initial.body.private_key).toBe("string")
		expect(typeof initial.body.public_rotated_at).toBe("string")

		const rolledPublic = await harness.request("POST", "/v2/ingest_keys/public/roll", {
			token: key.secret,
		})
		expect(rolledPublic.status).toBe(200)
		expect(rolledPublic.body.public_key).not.toBe(initial.body.public_key)
		expect(rolledPublic.body.private_key).toBe(initial.body.private_key)

		const rolledPrivate = await harness.request("POST", "/v2/ingest_keys/private/roll", {
			token: key.secret,
		})
		expect(rolledPrivate.status).toBe(200)
		expect(rolledPrivate.body.private_key).not.toBe(initial.body.private_key)
		await harness.dispose()
	})

	it("enforces the ingest_keys scope family", async () => {
		const harness = makeHarness()
		const scoped = await harness.bootstrapKey(["dashboards:read"])

		const denied = await harness.request("GET", "/v2/ingest_keys", { token: scoped.secret })
		expect(denied.status).toBe(403)
		expect(denied.body.error.type).toBe("permission_error")
		await harness.dispose()
	})
})

describe("v2 scrape_targets over HTTP", () => {
	it("full CRUD round-trip for a prometheus target", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey()

		const created = await harness.request("POST", "/v2/scrape_targets", {
			token: key.secret,
			body: {
				name: "payments prometheus",
				url: "https://example.com:1/metrics",
				target_type: "prometheus",
				scrape_interval_seconds: 60,
			},
		})
		expect(created.status).toBe(200)
		expect(created.body.object).toBe("scrape_target")
		expect(created.body.id.startsWith("scrp_")).toBe(true)
		expect(created.body.target_type).toBe("prometheus")
		expect(created.body.has_credentials).toBe(false)
		expect(created.body.enabled).toBe(true)

		const list = await harness.request("GET", "/v2/scrape_targets", { token: key.secret })
		expect(list.status).toBe(200)
		expect(list.body.object).toBe("list")
		expect(list.body.data).toHaveLength(1)

		const retrieved = await harness.request("GET", `/v2/scrape_targets/${created.body.id}`, {
			token: key.secret,
		})
		expect(retrieved.status).toBe(200)
		expect(retrieved.body.id).toBe(created.body.id)

		const updated = await harness.request("PATCH", `/v2/scrape_targets/${created.body.id}`, {
			token: key.secret,
			body: { enabled: false },
		})
		expect(updated.status).toBe(200)
		expect(updated.body.enabled).toBe(false)

		const checks = await harness.request("GET", `/v2/scrape_targets/${created.body.id}/checks`, {
			token: key.secret,
		})
		expect(checks.status).toBe(200)
		expect(checks.body.object).toBe("list")
		expect(checks.body.data).toHaveLength(0)

		const deleted = await harness.request("DELETE", `/v2/scrape_targets/${created.body.id}`, {
			token: key.secret,
		})
		expect(deleted.status).toBe(200)
		expect(deleted.body).toEqual({ id: created.body.id, object: "scrape_target", deleted: true })
		await harness.dispose()
	})

	it("paginates scrape checks beyond the former 200-row window", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey()
		const created = await harness.request("POST", "/v2/scrape_targets", {
			token: key.secret,
			body: {
				name: "pagination prometheus",
				url: "https://example.com:1/metrics",
				target_type: "prometheus",
				scrape_interval_seconds: 60,
			},
		})
		expect(created.status).toBe(200)
		await harness.seedScrapeChecks(created.body.id, 205)

		let cursor: string | null = null
		const seen = new Set<string>()
		do {
			const suffix = cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`
			const page = await harness.request(
				"GET",
				`/v2/scrape_targets/${created.body.id}/checks?limit=100${suffix}`,
				{ token: key.secret },
			)
			expect(page.status).toBe(200)
			for (const check of page.body.data) {
				seen.add(`${check.timestamp}:${check.duration_seconds}`)
			}
			cursor = page.body.next_cursor
		} while (cursor !== null)

		expect(seen.size).toBe(205)
		await harness.dispose()
	})

	it("rejects an invalid target with invalid_request_error", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey()

		// Prometheus target without a URL fails service validation.
		const invalid = await harness.request("POST", "/v2/scrape_targets", {
			token: key.secret,
			body: { name: "no url", target_type: "prometheus" },
		})
		expect(invalid.status).toBe(400)
		expect(invalid.body.error.type).toBe("invalid_request_error")
		await harness.dispose()
	})
})

describe("v2 instrumentation recommendations over HTTP", () => {
	it("returns the list envelope (empty telemetry reconciles to no issues)", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey()

		const list = await harness.request("GET", "/v2/instrumentation/recommendations", {
			token: key.secret,
		})
		expect(list.status).toBe(200)
		expect(list.body.object).toBe("list")
		expect(list.body.data).toEqual([])
		expect(list.body.has_more).toBe(false)

		const missing = await harness.request(
			"POST",
			"/v2/instrumentation/recommendations/rec_YofPTrK9782DWwcnXhpcCw/dismiss",
			{ token: key.secret },
		)
		expect(missing.status).toBe(404)
		expect(missing.body.error.type).toBe("not_found_error")
		await harness.dispose()
	})

	it("uses the instrumentation scope family", async () => {
		const harness = makeHarness()
		const readOnly = await harness.bootstrapKey(["instrumentation:read"])

		const list = await harness.request("GET", "/v2/instrumentation/recommendations", {
			token: readOnly.secret,
		})
		expect(list.status).toBe(200)

		const dismiss = await harness.request(
			"POST",
			"/v2/instrumentation/recommendations/rec_YofPTrK9782DWwcnXhpcCw/dismiss",
			{ token: readOnly.secret },
		)
		expect(dismiss.status).toBe(403)
		expect(dismiss.body.error.code).toBe("insufficient_scope")

		const oldFamily = await harness.bootstrapKey(["recommendations:read"])
		const denied = await harness.request("GET", "/v2/instrumentation/recommendations", {
			token: oldFamily.secret,
		})
		expect(denied.status).toBe(403)
		await harness.dispose()
	})
})

describe("v2 unexpected-error envelope", () => {
	it("sanitizes route defects without exposing their message", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey()
		const response = await harness.request("GET", "/v2/organization", { token: key.secret })
		expect(response.status).toBe(500)
		expect(response.body).toEqual({
			error: {
				type: "api_error",
				code: "internal_error",
				message: "An unexpected error occurred on our end.",
			},
		})
		expect(JSON.stringify(response.body)).not.toContain("not available in this test harness")
		await harness.dispose()
	})
})

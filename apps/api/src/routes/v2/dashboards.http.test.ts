import { afterEach, describe, expect, it } from "vitest"
import { ConfigProvider, Context, Effect, Layer, ManagedRuntime, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { OrgId, UserId } from "@maple/domain/http"
import { MapleApiV2 } from "@maple/domain/http/v2"
import { Env } from "../../lib/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "../../lib/test-pglite"
import { ApiKeysService } from "../../services/ApiKeysService"
import { AuthService } from "../../services/AuthService"
import { DashboardPersistenceService } from "../../services/DashboardPersistenceService"
import { ApiAuthorizationV2Layer } from "../../services/ApiAuthorizationV2Layer"
import { V2SchemaErrorsLive } from "./error-envelope"
import { AlertsServiceStubLayer, AllV2GroupLayersLive } from "./v2-test-support"

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const testConfig = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3478",
			MCP_PORT: "3479",
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

const makeHarness = () => {
	const testDb = createTestDb(createdDbs)
	const envLive = Env.layer.pipe(Layer.provide(testConfig()))
	const servicesLive = Layer.mergeAll(
		ApiKeysService.layer,
		AuthService.layer,
		DashboardPersistenceService.layer,
	).pipe(Layer.provideMerge(Layer.mergeAll(envLive, testDb.layer)))

	const routes = HttpApiBuilder.layer(MapleApiV2).pipe(
		Layer.provide(AllV2GroupLayersLive),
		Layer.provide(V2SchemaErrorsLive),
		Layer.provide(AlertsServiceStubLayer),
		Layer.provideMerge(ApiAuthorizationV2Layer),
		Layer.provideMerge(servicesLive),
	)
	const { handler, dispose: disposeHandler } = HttpRouter.toWebHandler(routes, {
		disableLogger: true,
	})
	const runtime = ManagedRuntime.make(servicesLive)
	const ORG = Schema.decodeUnknownSync(OrgId)("org_dashboard_e2e")
	const USER = Schema.decodeUnknownSync(UserId)("user_dashboard_e2e")

	const bootstrapKey = (scopes?: ReadonlyArray<string>) =>
		runtime.runPromise(
			Effect.gen(function* () {
				const service = yield* ApiKeysService
				return yield* service.create(ORG, USER, { name: "dashboard-test", scopes })
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

describe("v2 dashboards over HTTP", () => {
	it("supports headless CRUD and version restore with v2 wire conventions", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey(["dashboards:write"])

		const created = await harness.request("POST", "/v2/dashboards", key.secret, {
			name: "Operations",
			description: "Production overview",
			tags: ["production"],
			time_range: { type: "relative", value: "12h" },
			widgets: [],
			variables: [],
		})
		expect(created.status).toBe(200)
		expect(created.body.object).toBe("dashboard")
		expect(created.body.id).toMatch(/^dash_/)
		expect(created.body.time_range).toEqual({ type: "relative", value: "12h" })
		expect(created.body.txid).toMatch(/^\d+$/)
		expect("timeRange" in created.body).toBe(false)

		const id: string = created.body.id
		const listed = await harness.request("GET", "/v2/dashboards?limit=1", key.secret)
		expect(listed.status).toBe(200)
		expect(listed.body).toMatchObject({ object: "list", has_more: false, next_cursor: null })
		expect(listed.body.data[0].id).toBe(id)
		expect("txid" in listed.body.data[0]).toBe(false)

		const retrieved = await harness.request("GET", `/v2/dashboards/${id}`, key.secret)
		expect(retrieved.status).toBe(200)
		expect(retrieved.body.description).toBe("Production overview")

		const updated = await harness.request("PATCH", `/v2/dashboards/${id}`, key.secret, {
			name: "Operations v2",
			description: null,
			time_range: {
				type: "absolute",
				start_time: "2026-07-15T00:00:00.000Z",
				end_time: "2026-07-16T00:00:00.000Z",
			},
		})
		expect(updated.status).toBe(200)
		expect(updated.body.name).toBe("Operations v2")
		expect(updated.body.description).toBeNull()
		expect(updated.body.time_range.start_time).toBe("2026-07-15T00:00:00.000Z")
		expect(updated.body.txid).toMatch(/^\d+$/)

		const versions = await harness.request("GET", `/v2/dashboards/${id}/versions?limit=100`, key.secret)
		expect(versions.status).toBe(200)
		expect(versions.body.object).toBe("list")
		expect(versions.body.data.length).toBeGreaterThanOrEqual(2)
		expect(versions.body.data[0].id).toMatch(/^dbv_/)
		expect(versions.body.data[0].dashboard_id).toBe(id)

		const oldest = versions.body.data.at(-1)
		const detail = await harness.request("GET", `/v2/dashboards/${id}/versions/${oldest.id}`, key.secret)
		expect(detail.status).toBe(200)
		expect(detail.body.snapshot.object).toBe("dashboard")
		expect(detail.body.snapshot.name).toBe("Operations")

		const restored = await harness.request(
			"POST",
			`/v2/dashboards/${id}/versions/${oldest.id}/restore`,
			key.secret,
		)
		expect(restored.status).toBe(200)
		expect(restored.body.name).toBe("Operations")
		expect(restored.body.txid).toMatch(/^\d+$/)

		const deleted = await harness.request("DELETE", `/v2/dashboards/${id}`, key.secret)
		expect(deleted.status).toBe(200)
		expect(deleted.body).toMatchObject({ id, object: "dashboard", deleted: true })
		expect(deleted.body.txid).toMatch(/^\d+$/)

		const missing = await harness.request("GET", `/v2/dashboards/${id}`, key.secret)
		expect(missing.status).toBe(404)
		expect(missing.body.error).toMatchObject({
			type: "not_found_error",
			code: "resource_missing",
		})
		await harness.dispose()
	})

	it("enforces dashboard read/write scopes", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey(["dashboards:read"])
		const list = await harness.request("GET", "/v2/dashboards", key.secret)
		expect(list.status).toBe(200)

		const create = await harness.request("POST", "/v2/dashboards", key.secret, { name: "Denied" })
		expect(create.status).toBe(403)
		expect(create.body.error).toMatchObject({
			type: "permission_error",
			code: "insufficient_scope",
		})
		await harness.dispose()
	})
})

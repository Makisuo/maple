import { afterEach, describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Context, Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { CurrentTenant, DashboardsApiGroup } from "@maple/domain/http"
import { Env } from "@/lib/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "@/lib/test-pglite"
import { DashboardPersistenceService } from "@/services/dashboards/DashboardPersistenceService"
import { HttpDashboardSchemaErrorsLive, HttpDashboardsLive } from "./dashboards.http"

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

/**
 * Only the dashboards group, so the harness doesn't have to stand up every v1
 * service. The api id must stay `"MapleApi"` — `HttpApiBuilder.group` keys its
 * layer on `(apiId, groupIdentifier)`, so this is what lets the real
 * `HttpDashboardsLive` satisfy it.
 */
class DashboardsOnlyApi extends HttpApi.make("MapleApi").add(DashboardsApiGroup) {}

const TENANT = new CurrentTenant.TenantSchema({
	orgId: "org_dashboards_schema_errors" as CurrentTenant.TenantSchema["orgId"],
	userId: "user_dashboards_schema_errors" as CurrentTenant.TenantSchema["userId"],
	roles: [],
	authMode: "self_hosted",
})

const AuthorizationStubLayer = Layer.succeed(
	CurrentTenant.Authorization,
	CurrentTenant.Authorization.of({
		bearer: (httpEffect) => Effect.provideService(httpEffect, CurrentTenant.Context, TENANT),
	}),
)

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
			INTERNAL_SERVICE_TOKEN: "test-internal-token",
		}),
	)

const makeHarness = () => {
	const testDb = createTestDb(createdDbs)
	const envLive = Env.layer.pipe(Layer.provide(testConfig()))
	const servicesLive = DashboardPersistenceService.layer.pipe(
		Layer.provideMerge(Layer.mergeAll(envLive, testDb.layer)),
	)

	const routes = HttpApiBuilder.layer(DashboardsOnlyApi).pipe(
		Layer.provide(HttpDashboardsLive),
		Layer.provide(HttpDashboardSchemaErrorsLive),
		Layer.provideMerge(AuthorizationStubLayer),
		Layer.provideMerge(servicesLive),
	)
	const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true })

	const request = async (method: string, path: string, body: unknown) => {
		const response = await handler(
			new Request(`http://maple.test${path}`, {
				method,
				headers: { authorization: "Bearer test-token", "content-type": "application/json" },
				body: JSON.stringify(body),
			}),
			Context.empty() as never,
		)
		const text = await response.text()
		return { status: response.status, body: text.length === 0 ? null : JSON.parse(text) }
	}

	return { request, dispose }
}

const widget = (id: string, overrides: Record<string, unknown> = {}) => ({
	id,
	visualization: "line",
	dataSource: { endpoint: "traces_timeseries", params: {} },
	display: { title: id, chartPresentation: { legend: "visible" } },
	layout: { x: 0, y: 0, w: 6, h: 4 },
	...overrides,
})

describe("v1 dashboards request-decode failures", () => {
	it("answers a bad widget field with a 400 naming the widget id and the field path", async () => {
		const harness = makeHarness()
		try {
			const response = await harness.request("PUT", "/api/dashboards/dash_abc", {
				dashboard: {
					id: "dash_abc",
					name: "Operations",
					timeRange: { type: "relative", value: "12h" },
					widgets: [
						widget("latency-p99"),
						// `fillNulls` is `number | false`; `true` is the exact value that
						// used to produce an empty 400 with no way to find it.
						widget("error-rate", {
							display: { title: "error-rate", chartPresentation: { fillNulls: true } },
						}),
					],
					createdAt: "2026-08-02T00:00:00.000Z",
					updatedAt: "2026-08-02T00:00:00.000Z",
				},
			})

			expect(response.status).toBe(400)
			expect(response.body).not.toBeNull()
			expect(response.body._tag).toBe("@maple/http/errors/DashboardValidationError")
			expect(response.body.message).toContain("payload is invalid")

			const details: string[] = response.body.details
			expect(details).toHaveLength(1)
			const [detail] = details
			// widget id, so a 14-widget document doesn't need bisecting...
			expect(detail).toContain('widget "error-rate"')
			// ...the JSON path down to the offending key...
			expect(detail).toContain("dashboard.widgets[1].display.chartPresentation.fillNulls")
			// ...and what was expected versus what arrived.
			expect(detail).toContain("true")
			expect(detail).toMatch(/Expected/)
			// The widget that decoded cleanly is not mentioned.
			expect(detail).not.toContain("latency-p99")
		} finally {
			await harness.dispose()
		}
	})

	it("omits widget attribution for a field outside widgets[]", async () => {
		const harness = makeHarness()
		try {
			const response = await harness.request("POST", "/api/dashboards", {
				dashboard: {
					name: 42,
					timeRange: { type: "relative", value: "12h" },
					widgets: [widget("cpu")],
				},
			})

			expect(response.status).toBe(400)
			// The runtime decoder stops at the first offending key, so a document
			// with several bad fields surfaces them one request at a time.
			const details: string[] = response.body.details
			expect(details).toHaveLength(1)
			expect(details[0]).toContain("dashboard.name")
			expect(details[0]).not.toContain("widget")
		} finally {
			await harness.dispose()
		}
	})

	it("attributes a bad widget layout field to its widget", async () => {
		const harness = makeHarness()
		try {
			const response = await harness.request("POST", "/api/dashboards", {
				dashboard: {
					name: "Operations",
					timeRange: { type: "relative", value: "12h" },
					widgets: [widget("cpu", { layout: { x: 0, y: 0, w: "six", h: 4 } })],
				},
			})

			expect(response.status).toBe(400)
			const [detail] = response.body.details as string[]
			expect(detail).toContain("dashboard.widgets[0].layout.w")
			expect(detail).toContain('widget "cpu"')
		} finally {
			await harness.dispose()
		}
	})

	it("still accepts a valid document", async () => {
		const harness = makeHarness()
		try {
			const response = await harness.request("POST", "/api/dashboards", {
				dashboard: {
					name: "Operations",
					timeRange: { type: "relative", value: "12h" },
					widgets: [widget("cpu", { display: { chartPresentation: { fillNulls: false } } })],
				},
			})

			expect(response.status).toBe(200)
			expect(response.body.widgets).toHaveLength(1)
		} finally {
			await harness.dispose()
		}
	})
})

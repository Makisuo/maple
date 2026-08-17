import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { OrgId, UserId } from "@maple/domain/http"
import { DashboardPersistenceService } from "./DashboardPersistenceService"
import { Env } from "@/platform/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "@/platform/test-pglite"
import { convertPersesDashboardToPortable } from "./perses-dashboard-import"

const trackedDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(trackedDbs))

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)

const testConfig = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3472",
			MCP_PORT: "3473",
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
		}),
	)

const makePersistenceLayer = (testDb: TestDb) =>
	DashboardPersistenceService.layer.pipe(
		Layer.provide(testDb.layer),
		Layer.provide(Env.layer),
		Layer.provide(testConfig()),
	)

function persesDashboard(overrides: Record<string, unknown> = {}) {
	return {
		kind: "Dashboard",
		metadata: { name: "system-overview", project: "prod" },
		spec: {
			display: { name: "System Overview", description: "Imported from Perses" },
			duration: "6h",
			datasources: {
				ClickHouseMain: {
					kind: "ClickHouseDatasource",
					spec: { directUrl: "http://clickhouse:8123" },
				},
			},
			variables: [{ kind: "TextVariable", spec: { name: "service" } }],
			panels: {
				requests: {
					kind: "Panel",
					spec: {
						display: { name: "Requests" },
						plugin: { kind: "TimeSeriesChart", spec: { unit: "number" } },
						queries: [
							{
								kind: "TimeSeriesQuery",
								spec: {
									plugin: {
										kind: "ClickHouseTimeSeriesQuery",
										spec: {
											query: "SELECT toStartOfInterval(Timestamp, INTERVAL $__interval_s SECOND) AS bucket, count() AS requests FROM logs WHERE $__orgFilter AND $__timeFilter(Timestamp) GROUP BY bucket ORDER BY bucket",
										},
									},
								},
							},
						],
					},
				},
			},
			layouts: [
				{
					kind: "Grid",
					spec: {
						items: [
							{
								x: 10,
								y: 0,
								width: 4,
								height: 5,
								content: { $ref: "#/spec/panels/requests" },
							},
						],
					},
				},
			],
		},
		...overrides,
	}
}

describe("convertPersesDashboardToPortable", () => {
	it.effect("converts a ClickHouse time series panel into a raw SQL chart widget", () =>
		Effect.gen(function* () {
			const result = yield* convertPersesDashboardToPortable(persesDashboard())
			const widget = result.dashboard.widgets[0]!

			assert.strictEqual(result.dashboard.name, "System Overview")
			assert.strictEqual(result.dashboard.description, "Imported from Perses")
			assert.deepStrictEqual(result.dashboard.tags, ["perses-import"])
			assert.deepStrictEqual(result.dashboard.timeRange, { type: "relative", value: "6h" })
			assert.strictEqual(widget.visualization, "chart")
			assert.strictEqual(widget.dataSource.kind, "raw_sql")
			assert.strictEqual(
				widget.dataSource.kind === "raw_sql" ? widget.dataSource.displayType : undefined,
				"line",
			)
			assert.strictEqual(widget.display.title, "Requests")
			assert.strictEqual(widget.layout.x, 10)
			assert.strictEqual(widget.layout.w, 2)
			assert.isTrue(result.warnings.some((warning) => warning.includes("Clamped layout")))
			assert.isTrue(result.warnings.some((warning) => warning.includes("variables are not imported")))
		}),
	)

	it.effect("turns unsupported query plugins into placeholder widgets", () =>
		Effect.gen(function* () {
			const input = persesDashboard({
				spec: {
					...persesDashboard().spec,
					panels: {
						prometheus: {
							kind: "Panel",
							spec: {
								display: { name: "Prometheus Rate" },
								plugin: { kind: "TimeSeriesChart", spec: {} },
								queries: [
									{
										kind: "TimeSeriesQuery",
										spec: {
											plugin: {
												kind: "PrometheusTimeSeriesQuery",
												spec: { query: "rate(http_requests_total[5m])" },
											},
										},
									},
								],
							},
						},
					},
					layouts: [
						{
							kind: "Grid",
							spec: {
								items: [
									{
										x: 0,
										y: 0,
										width: 6,
										height: 5,
										content: { $ref: "#/spec/panels/prometheus" },
									},
								],
							},
						},
					],
				},
			})

			const result = yield* convertPersesDashboardToPortable(input)
			const widget = result.dashboard.widgets[0]!

			assert.strictEqual(widget.visualization, "markdown")
			assert.include(widget.display.markdown?.content ?? "", "PrometheusTimeSeriesQuery")
			assert.isTrue(result.warnings.some((warning) => warning.includes("unsupported query plugin")))
		}),
	)

	it.effect("keeps unsafe ClickHouse SQL as a placeholder", () =>
		Effect.gen(function* () {
			const input = persesDashboard({
				spec: {
					...persesDashboard().spec,
					panels: {
						unsafe: {
							kind: "Panel",
							spec: {
								display: { name: "Unsafe SQL" },
								plugin: { kind: "Table", spec: {} },
								queries: [
									{
										kind: "LogQuery",
										spec: {
											plugin: {
												kind: "ClickHouseLogQuery",
												spec: {
													query: "SELECT Timestamp, Body FROM logs ORDER BY Timestamp DESC",
												},
											},
										},
									},
								],
							},
						},
					},
					layouts: [
						{
							kind: "Grid",
							spec: {
								items: [
									{
										x: 0,
										y: 0,
										width: 6,
										height: 5,
										content: { $ref: "#/spec/panels/unsafe" },
									},
								],
							},
						},
					],
				},
			})

			const result = yield* convertPersesDashboardToPortable(input)
			const widget = result.dashboard.widgets[0]!

			assert.strictEqual(widget.visualization, "markdown")
			assert.include(widget.display.markdown?.content ?? "", "needs Maple org scoping")
			assert.isTrue(
				result.warnings.some((warning) => warning.includes("does not include $__orgFilter")),
			)
		}),
	)

	it.effect("adds Maple org scoping to ClickHouse SQL with an explicit OrgId reference", () =>
		Effect.gen(function* () {
			const input = persesDashboard({
				spec: {
					...persesDashboard().spec,
					panels: {
						logs: {
							kind: "Panel",
							spec: {
								display: { name: "Logs" },
								plugin: { kind: "Table", spec: {} },
								queries: [
									{
										kind: "LogQuery",
										spec: {
											plugin: {
												kind: "ClickHouseLogQuery",
												spec: {
													query: "SELECT Timestamp, Body FROM logs WHERE OrgId = 'external' ORDER BY Timestamp DESC LIMIT 100",
												},
											},
										},
									},
								],
							},
						},
					},
					layouts: [
						{
							kind: "Grid",
							spec: {
								items: [
									{
										x: 0,
										y: 0,
										width: 6,
										height: 5,
										content: { $ref: "#/spec/panels/logs" },
									},
								],
							},
						},
					],
				},
			})

			const result = yield* convertPersesDashboardToPortable(input)
			const widget = result.dashboard.widgets[0]!
			if (widget.dataSource.kind !== "raw_sql") throw new Error("expected a raw_sql data source")
			const params: Record<string, unknown> = widget.dataSource

			assert.strictEqual(widget.visualization, "table")
			assert.strictEqual(params.displayType, "table")
			assert.include(String(params.sql), "AND $__orgFilter ORDER BY")
			assert.isTrue(result.warnings.some((warning) => warning.includes("explicit OrgId reference")))
		}),
	)

	it.effect("imports markdown panels and generates missing layouts", () =>
		Effect.gen(function* () {
			const result = yield* convertPersesDashboardToPortable(
				persesDashboard({
					spec: {
						display: { name: "Notes" },
						duration: "30m",
						panels: {
							intro: {
								kind: "Panel",
								spec: {
									display: { name: "Intro" },
									plugin: { kind: "Markdown", spec: { text: "Hello from Perses" } },
								},
							},
						},
					},
				}),
			)

			const widget = result.dashboard.widgets[0]!
			assert.strictEqual(widget.visualization, "markdown")
			assert.strictEqual(widget.display.markdown?.content, "Hello from Perses")
			assert.deepStrictEqual(widget.layout, { x: 0, y: 0, w: 6, h: 5, minW: 3, minH: 3 })
			assert.isTrue(result.warnings.some((warning) => warning.includes("no layouts")))
		}),
	)

	it.effect("creates a persisted dashboard from the converted import payload", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const converted = yield* convertPersesDashboardToPortable(persesDashboard())
			const created = yield* DashboardPersistenceService.create(
				asOrgId("org_perses"),
				asUserId("user_perses"),
				converted.dashboard,
			)
			const listed = yield* DashboardPersistenceService.list(asOrgId("org_perses"))

			assert.strictEqual(created.name, "System Overview")
			assert.strictEqual(created.widgets.length, 1)
			assert.strictEqual(listed.dashboards.length, 1)
			assert.strictEqual(listed.dashboards[0]?.name, "System Overview")
		}).pipe(Effect.provide(makePersistenceLayer(testDb)))
	})
})

// Regression tests for the dashboard mutation pipeline against dashboards whose
// stored document has NO `tags` and NO `description` key.
//
// `DashboardDocument.{tags,description}` are `Schema.optionalKey(...)`: the
// Schema.Class constructor permits the key to be *absent* but rejects a present
// `undefined` ("Expected array, got undefined at [\"tags\"]"). Several rebuild
// sites used to forward `existing.tags` / `existing.description` straight into
// `new DashboardDocument({ ... })`, which is `undefined` for a tag-less /
// description-less dashboard — crashing every incremental MCP widget tool
// (add/update/remove/reorder) and metadata-only `update_dashboard` calls. These
// tests drive the real production paths and assert they succeed.

import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { DashboardDocument, DashboardId, IsoDateTimeString, OrgId, UserId } from "@maple/domain/http"
import { DashboardPersistenceService } from "@/services/dashboards/DashboardPersistenceService"
import { SharedDashboardService } from "@/services/dashboards/SharedDashboardService"
import { Env } from "@/platform/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "@/platform/test-pglite"
import { decodeDataSourceJson, decodeWidgetJson, withDashboardMutation } from "./dashboard-mutations"
import { CurrentMcpTenant } from "./query-warehouse"
import { registerUpdateDashboardTool } from "@/mcp/tools/update-dashboard"
import type { McpToolError, McpToolRegistrar, McpToolResult } from "@/mcp/tools/types"

const trackedDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(trackedDbs))

// MCP transport authentication resolves the tenant before dispatch. Tool tests
// inject that already-resolved context directly, matching both HTTP and RPC.
const INTERNAL_TOKEN = "test-internal-token"
const ORG = "org_no_tags"

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
			INTERNAL_SERVICE_TOKEN: INTERNAL_TOKEN,
		}),
	)

const makeLayer = (testDb: TestDb) =>
	Layer.mergeAll(
		DashboardPersistenceService.layer,
		SharedDashboardService.layer,
		Layer.succeed(CurrentMcpTenant, {
			orgId: Schema.decodeUnknownSync(OrgId)(ORG),
			userId: Schema.decodeUnknownSync(UserId)("internal-service"),
			roles: [],
			authMode: "self_hosted",
		}),
	).pipe(Layer.provide(testDb.layer), Layer.provideMerge(Env.layer), Layer.provide(testConfig()))

const asDashboardId = Schema.decodeUnknownSync(DashboardId)
const asIsoDateTimeString = Schema.decodeUnknownSync(IsoDateTimeString)
const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)

const DASHBOARD = asDashboardId("dash-no-tags")
const NOW = asIsoDateTimeString(new Date("2026-01-01T00:00:00.000Z").toISOString())

const widget = (id: string) => ({
	id,
	visualization: "stat",
	dataSource: { kind: "route", endpoint: "test" },
	display: {},
	layout: { x: 0, y: 0, w: 3, h: 4 },
})

// A dashboard with NEITHER a `tags` nor a `description` key — the on-disk shape
// MCP/template-created dashboards can have. Both keys are simply omitted (absent,
// not `undefined`), which is the only shape the Schema.Class constructor accepts.
const seed = (): DashboardDocument =>
	new DashboardDocument({
		id: DASHBOARD,
		name: "Tag-less dashboard",
		timeRange: { type: "relative", value: "12h" },
		widgets: [],
		createdAt: NOW,
		updatedAt: NOW,
	})

// A dashboard using every field a widget mutation must carry forward but never
// touches: sections with tabs, a variable, and an auto-refresh cadence.
const grouped = (): DashboardDocument =>
	new DashboardDocument({
		id: DASHBOARD,
		name: "Grouped dashboard",
		timeRange: { type: "relative", value: "12h" },
		widgets: [{ ...widget("w-1"), sectionId: "sec-1", tabId: "tab-1" }],
		sections: [
			{
				id: "sec-1",
				title: "Latency",
				tabs: [
					{ id: "tab-1", title: "Overview" },
					{ id: "tab-2", title: "By route" },
				],
			},
		],
		variables: [{ type: "custom", name: "env", options: [{ value: "prod" }, { value: "stg" }] }],
		refreshIntervalSeconds: 30,
		createdAt: NOW,
		updatedAt: NOW,
	})

type ToolHandler = (params: {
	dashboard_id: string
	name?: string
	description?: string
	time_range?: string
	dashboard_json?: string
}) => Effect.Effect<McpToolResult, McpToolError, never>

describe("dashboard mutations on tag-less / description-less dashboards", () => {
	it.effect("withDashboardMutation adds a widget without crashing on the absent tags key", () => {
		const testDb = createTestDb(trackedDbs)
		const layer = makeLayer(testDb)

		return Effect.gen(function* () {
			yield* DashboardPersistenceService.upsert(asOrgId(ORG), asUserId("seed-user"), seed())

			const result = yield* withDashboardMutation(DASHBOARD, "update_dashboard_widget", (widgets) =>
				Effect.succeed([...widgets, widget("w-new")]),
			)

			assert.strictEqual(result.ok, true)

			const listed = yield* DashboardPersistenceService.list(asOrgId(ORG))
			assert.strictEqual(listed.dashboards.length, 1)
			assert.deepStrictEqual(
				listed.dashboards[0]!.widgets.map((w) => w.id),
				["w-new"],
			)
		}).pipe(Effect.provide(layer))
	})

	// A widget mutation must carry the ENTIRE document forward. The rebuild used
	// to name its fields, so `sections`, `variables` and `refreshIntervalSeconds`
	// were dropped by every add/update/remove/reorder/replace — and because
	// `sanitizeDashboardSections` then strips the newly-orphaned `sectionId` /
	// `tabId` off each widget on write, the loss was unrecoverable.
	it.effect("withDashboardMutation preserves sections, variables and refresh interval", () => {
		const testDb = createTestDb(trackedDbs)
		const layer = makeLayer(testDb)

		return Effect.gen(function* () {
			yield* DashboardPersistenceService.upsert(asOrgId(ORG), asUserId("seed-user"), grouped())

			const result = yield* withDashboardMutation(DASHBOARD, "add_dashboard_widget", (widgets) =>
				Effect.succeed([...widgets, { ...widget("w-new"), sectionId: "sec-1", tabId: "tab-1" }]),
			)
			assert.strictEqual(result.ok, true)

			const [stored] = (yield* DashboardPersistenceService.list(asOrgId(ORG))).dashboards
			assert.isDefined(stored)

			assert.deepStrictEqual(stored.sections, grouped().sections)
			assert.deepStrictEqual(stored.variables, grouped().variables)
			assert.strictEqual(stored.refreshIntervalSeconds, 30)

			// The pre-existing widget keeps its container, and the added one lands in
			// the section it asked for rather than being flattened onto the root canvas.
			assert.deepStrictEqual(
				stored.widgets.map((w) => [w.id, w.sectionId, w.tabId]),
				[
					["w-1", "sec-1", "tab-1"],
					["w-new", "sec-1", "tab-1"],
				],
			)
		}).pipe(Effect.provide(layer))
	})

	it.effect("update_dashboard renames a dashboard that has no tags or description", () => {
		const testDb = createTestDb(trackedDbs)
		const layer = makeLayer(testDb)

		let handler: ToolHandler | null = null
		const registrar: McpToolRegistrar = {
			tool: (_name, _description, _schema, h) => {
				handler = h as ToolHandler
			},
		}
		registerUpdateDashboardTool(registrar)
		assert.isNotNull(handler)
		const invoke = handler as ToolHandler

		return Effect.gen(function* () {
			yield* DashboardPersistenceService.upsert(asOrgId(ORG), asUserId("seed-user"), seed())

			const result = yield* invoke({ dashboard_id: DASHBOARD, name: "Renamed" })

			assert.notStrictEqual(result.isError, true)

			const listed = yield* DashboardPersistenceService.list(asOrgId(ORG))
			assert.strictEqual(listed.dashboards[0]!.name, "Renamed")
		}).pipe(Effect.provide(layer))
	})
})

// The payloads the OLD documentation taught. Each one is what an agent trained
// on the pre-v3 tool descriptions — or working from a stale transcript — still
// produces. The point is not that they fail (a union decode always failed);
// it is that the failure now NAMES the v3 replacement instead of dumping four
// per-arm decode errors.
describe("legacy v2 payloads get a corrective error", () => {
	const decodeErrorOf = (json: string) =>
		Effect.flip(decodeDataSourceJson(json, "test")).pipe(Effect.map((error) => error.message))

	it.effect("markdown_static → kind: static", () =>
		Effect.gen(function* () {
			const message = yield* decodeErrorOf('{"endpoint":"markdown_static"}')
			assert.include(message, "legacy v2 data-source shape")
			assert.include(message, '{"kind":"static"}')
		}),
	)

	it.effect("custom_query_builder_timeseries → kind: query with resultShape", () =>
		Effect.gen(function* () {
			const message = yield* decodeErrorOf(
				'{"endpoint":"custom_query_builder_timeseries","params":{"queries":[]}}',
			)
			assert.include(message, '"resultShape":"timeseries"')
			assert.include(message, "TOP LEVEL")
		}),
	)

	it.effect("custom_query_builder_breakdown carries its own result shape", () =>
		Effect.gen(function* () {
			const message = yield* decodeErrorOf('{"endpoint":"custom_query_builder_breakdown"}')
			assert.include(message, '"resultShape":"breakdown"')
		}),
	)

	it.effect("raw_sql_chart → kind: raw_sql", () =>
		Effect.gen(function* () {
			const message = yield* decodeErrorOf('{"endpoint":"raw_sql_chart","params":{"sql":"SELECT 1"}}')
			assert.include(message, '{"kind":"raw_sql"')
		}),
	)

	it.effect("an unrecognised endpoint maps to the route arm rather than being guessed at", () =>
		Effect.gen(function* () {
			const message = yield* decodeErrorOf('{"endpoint":"service_overview","params":{}}')
			assert.include(message, '"kind":"route"')
			assert.include(message, "service_overview")
		}),
	)

	it.effect("a whole widget carrying a v2 dataSource gets the same hint", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(
				decodeWidgetJson(
					JSON.stringify({
						id: "w1",
						visualization: "markdown",
						dataSource: { endpoint: "markdown_static" },
						display: {},
						layout: { x: 0, y: 0, w: 4, h: 5 },
					}),
					"test",
				),
			)
			assert.include(error.message, '{"kind":"static"}')
		}),
	)

	it.effect("a valid v3 source still decodes untouched", () =>
		Effect.gen(function* () {
			const source = yield* decodeDataSourceJson('{"kind":"static"}', "test")
			assert.deepStrictEqual(source, { kind: "static" })
		}),
	)

	it.effect("a genuinely malformed source keeps the raw decode error", () =>
		Effect.gen(function* () {
			const message = yield* decodeErrorOf('{"kind":"raw_sql"}')
			assert.notInclude(message, "legacy v2")
			assert.include(message, "Invalid data_source_json")
		}),
	)
})

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
import { DashboardPersistenceService } from "@/services/DashboardPersistenceService"
import { Env } from "@/lib/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "@/lib/test-pglite"
import { withDashboardMutation } from "./dashboard-mutations"
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
	dataSource: { endpoint: "test" },
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
		const invoke = handler as unknown as ToolHandler

		return Effect.gen(function* () {
			yield* DashboardPersistenceService.upsert(asOrgId(ORG), asUserId("seed-user"), seed())

			const result = yield* invoke({ dashboard_id: DASHBOARD, name: "Renamed" })

			assert.notStrictEqual(result.isError, true)

			const listed = yield* DashboardPersistenceService.list(asOrgId(ORG))
			assert.strictEqual(listed.dashboards[0]!.name, "Renamed")
		}).pipe(Effect.provide(layer))
	})
})

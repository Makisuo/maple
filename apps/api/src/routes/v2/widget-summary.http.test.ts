import { afterEach, describe, expect, it } from "@effect/vitest"
import {
	ErrorIssueDocument,
	ErrorIssueId,
	ErrorIssuesListResponse,
	IsoDateTimeString,
	OrgId,
	UserId,
} from "@maple/domain/http"
import { MapleApiV2 } from "@maple/domain/http/v2"
import { QueryEngineExecuteResponse } from "@maple/query-engine"
import { ConfigProvider, Context, Effect, Layer, ManagedRuntime, Option, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Env } from "@/platform/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "@/platform/test-pglite"
import { ApiAuthorizationV2Layer } from "@/services/auth/ApiAuthorizationV2Layer"
import { AuditLogService } from "@/services/audit/AuditLogService"
import { ApiKeysService } from "@/services/org/ApiKeysService"
import { AuthService } from "@/services/auth/AuthService"
import { DashboardPersistenceService } from "@/services/dashboards/DashboardPersistenceService"
import { ErrorIssueReadModelsService } from "@/services/errors/ErrorIssueReadModelsService"
import { LiveActivitiesService } from "@/services/push/LiveActivitiesService"
import { MobileDevicesService } from "@/services/push/MobileDevicesService"
import { SharedDashboardService } from "@/services/dashboards/SharedDashboardService"
import { QueryEngineService, type QueryEngineServiceApi } from "@/services/warehouse/QueryEngineService"
import { WarehouseQueryService } from "@/services/warehouse/WarehouseQueryService"
import { V2TransportErrorBoundaryLive } from "./error-envelope"
import {
	AlertsServiceStubLayer,
	AllV2GroupLayersLive,
	ApiV2RateLimiterAllowAllLayer,
	ConfigResourceServiceStubsLayer,
	makeWarehouseServiceStub,
	PlanetScaleServiceStubsLayer,
	SlackIntegrationServiceStubLayer,
} from "./v2-test-support"
import { compiledQueryOf } from "@maple/query-engine/execution"

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const testConfig = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3490",
			MCP_PORT: "3491",
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

const decodeIssueId = Schema.decodeSync(ErrorIssueId)
const decodeIso = Schema.decodeSync(IsoDateTimeString)

const issueDocument = (overrides: Partial<ErrorIssueDocument> = {}): ErrorIssueDocument =>
	new ErrorIssueDocument({
		id: decodeIssueId("11111111-1111-4111-8111-111111111111"),
		kind: "error",
		fingerprintHash: "12345",
		serviceName: "api",
		exceptionType: "TypeError",
		exceptionMessage: "Cannot read properties of undefined",
		errorLabel: "checkout",
		topFrame: "checkout.ts:12",
		workflowState: "triage",
		priority: 1,
		severity: "critical",
		severitySource: "detector",
		sourceRef: null,
		assignedActor: null,
		leaseHolder: null,
		leaseExpiresAt: null,
		claimedAt: null,
		notes: null,
		firstSeenAt: decodeIso("2026-08-20T09:00:00.000Z"),
		lastSeenAt: decodeIso("2026-08-21T09:08:12.000Z"),
		occurrenceCount: 412,
		resolvedAt: null,
		lastResolvedAt: null,
		lastRegressedAt: null,
		regressionCount: 2,
		resolvedVersions: [],
		snoozeUntil: null,
		archivedAt: null,
		hasOpenIncident: true,
		commentCount: 0,
		openPullRequestCount: 0,
		mergedPullRequestCount: 0,
		...overrides,
	})

const serviceRow = {
	serviceName: "api",
	serviceNamespaces: ["checkout"],
	deploymentEnvironments: ["production"],
	spanCount: "10",
	errorCount: "2",
	estimatedErrorCount: "4",
	estimatedSpanCount: "7200",
	p50LatencyMs: "10",
	p95LatencyMs: "40",
	p99LatencyMs: "50",
}

const warehouseStub = makeWarehouseServiceStub({
	compiledQuery: (_tenant, compiled) =>
		compiledQueryOf(compiled).decodeRows(
			compiledQueryOf(compiled).sql.includes("FROM service_overview_spans") ? [serviceRow] : [],
		),
	compiledQueryFirst: (_tenant, compiled) =>
		compiledQueryOf(compiled)
			.decodeRows([])
			.pipe(Effect.map((rows) => Option.fromNullishOr(rows[0]))),
	ingest: () => Effect.void,
})

const queryEngineStub = (execute: QueryEngineServiceApi["execute"]): QueryEngineServiceApi => ({
	execute,
	evaluate: () => Effect.die(new Error("not used")),
	evaluateSeries: () => Effect.die(new Error("not used")),
	cachedDirect: (_tenant, _route, _payload, effect) => effect,
})

/** Grouped requests carry a `service` group-by; the ungrouped one does not. */
const seriesEngine = queryEngineStub((_tenant, request) =>
	Effect.succeed(
		new QueryEngineExecuteResponse({
			result: {
				kind: "timeseries",
				source: "traces",
				data:
					request.query.kind === "timeseries" && request.query.groupBy !== undefined
						? [
								{ bucket: "2026-08-21T09:00:00", series: { api: 600 } },
								{ bucket: "2026-08-21T09:01:00", series: { api: 900 } },
							]
						: [
								{ bucket: "2026-08-21T09:00:00", series: { all: 1200 } },
								{ bucket: "2026-08-21T09:01:00", series: { all: 1800 } },
							],
			},
		}),
	),
)

const makeHarness = (options: {
	readonly listIssues?: ErrorIssueReadModelsService["listIssues"]
	readonly queryEngine?: QueryEngineServiceApi
	readonly warehouse?: WarehouseQueryService
}) => {
	const testDb = createTestDb(createdDbs)
	const envLive = Env.layer.pipe(Layer.provide(testConfig()))
	const servicesLive = Layer.mergeAll(
		ApiKeysService.layer,
		AuthService.layer,
		DashboardPersistenceService.layer,
		SharedDashboardService.layer,
		MobileDevicesService.layer,
		LiveActivitiesService.layer,
	).pipe(Layer.provideMerge(Layer.mergeAll(envLive, testDb.layer)))

	// Provided ahead of `ConfigResourceServiceStubsLayer`, whose issue read
	// models all `die` — this suite is the one that actually calls them.
	const readsLive = Layer.mergeAll(
		Layer.succeed(WarehouseQueryService, options.warehouse ?? warehouseStub),
		Layer.succeed(QueryEngineService, options.queryEngine ?? seriesEngine),
		Layer.succeed(ErrorIssueReadModelsService, {
			listIssues:
				options.listIssues ??
				(() => Effect.succeed(new ErrorIssuesListResponse({ issues: [issueDocument()] }))),
			countOpenIssuesByService: () => Effect.die(new Error("not used")),
			getIssue: () => Effect.die(new Error("not used")),
			listIssueIncidents: () => Effect.die(new Error("not used")),
			listOpenIncidents: () => Effect.die(new Error("not used")),
		} as ErrorIssueReadModelsService),
	)

	const routes = HttpApiBuilder.layer(MapleApiV2).pipe(
		Layer.provide(AllV2GroupLayersLive),
		Layer.provide(readsLive),
		Layer.provide(V2TransportErrorBoundaryLive),
		Layer.provide(SlackIntegrationServiceStubLayer),
		Layer.provide(PlanetScaleServiceStubsLayer),
		Layer.provide(AlertsServiceStubLayer),
		Layer.provide(ConfigResourceServiceStubsLayer),
		Layer.provideMerge(ApiAuthorizationV2Layer),
		Layer.provideMerge(AuditLogService.layerMemory),
		Layer.provideMerge(ApiV2RateLimiterAllowAllLayer),
		Layer.provideMerge(servicesLive),
	)
	const { handler, dispose: disposeHandler } = HttpRouter.toWebHandler(routes, { disableLogger: true })
	const runtime = ManagedRuntime.make(servicesLive)
	const org = Schema.decodeUnknownSync(OrgId)("org_widget_e2e")
	const user = Schema.decodeUnknownSync(UserId)("user_widget_e2e")
	const bootstrapKey = (scopes?: ReadonlyArray<string>) =>
		runtime.runPromise(
			Effect.gen(function* () {
				const service = yield* ApiKeysService
				return yield* service.create(org, user, { name: "widget-test", scopes })
			}),
		)
	const get = async (token: string, headers: Record<string, string> = {}, query = "") => {
		const response = await handler(
			new Request(`http://maple.test/v2/widget_summary${query}`, {
				headers: { authorization: `Bearer ${token}`, ...headers },
			}),
			Context.empty() as never,
		)
		const text = await response.text()
		return { status: response.status, body: text ? JSON.parse(text) : null }
	}
	return {
		org,
		bootstrapKey,
		get,
		dispose: async () => {
			await disposeHandler()
			await runtime.dispose()
		},
	}
}

describe("GET /v2/widget_summary", () => {
	it("returns both widget surfaces in one payload", async () => {
		const harness = makeHarness({})
		try {
			const key = await harness.bootstrapKey(["widget_summary:read"])
			const summary = await harness.get(key.secret)

			expect(summary.status).toBe(200)
			expect(summary.body).toMatchObject({
				object: "widget_summary",
				schema_version: 1,
				organization_id: harness.org,
				issues: { window_seconds: 86_400, has_more: false },
				throughput: { window_seconds: 3600 },
			})
			// The raw naming fields, not a rendered title: the client owns the
			// fallback so its issue list and its widget cannot disagree.
			expect(summary.body.issues.data[0]).toMatchObject({
				exception_type: "TypeError",
				error_label: "checkout",
				exception_message: "Cannot read properties of undefined",
				service_name: "api",
				severity: "critical",
				occurrence_count: 412,
				is_regressed: true,
				has_open_incident: true,
			})
			expect(summary.body.issues.data[0].id).toMatch(/^iss_/)

			// Bucket counts, not rates — 7200 estimated spans over the hour window.
			expect(summary.body.throughput.bucket_seconds).toBeGreaterThan(0)
			expect(summary.body.throughput.services[0]).toMatchObject({
				name: "api",
				throughput_per_second: 2,
				points: [600, 900],
			})
			expect(summary.body.throughput.total_points).toEqual([1200, 1800])
		} finally {
			await harness.dispose()
		}
	})

	it("reports has_more so the widget renders a floor rather than a wrong total", async () => {
		const harness = makeHarness({
			listIssues: () =>
				Effect.succeed(
					new ErrorIssuesListResponse({ issues: [issueDocument()], nextCursor: "next" }),
				),
		})
		try {
			const key = await harness.bootstrapKey(["widget_summary:read"])
			const summary = await harness.get(key.secret)
			expect(summary.body.issues.has_more).toBe(true)
		} finally {
			await harness.dispose()
		}
	})

	it("degrades the sparkline rather than the summary when the series read fails", async () => {
		const harness = makeHarness({
			queryEngine: queryEngineStub(() => Effect.die(new Error("warehouse down"))),
		})
		try {
			const key = await harness.bootstrapKey(["widget_summary:read"])
			const summary = await harness.get(key.secret)

			expect(summary.status).toBe(200)
			// Null, not the computed length: a bucket length attached to no points
			// invites the client to draw a unit it was never given.
			expect(summary.body.throughput.bucket_seconds).toBeNull()
			expect(summary.body.throughput.total_points).toEqual([])
			expect(summary.body.throughput.services[0].points).toEqual([])
			// The scalars survive, which is the whole point of degrading in place.
			expect(summary.body.throughput.services[0].throughput_per_second).toBe(2)
			expect(summary.body.issues.data).toHaveLength(1)
		} finally {
			await harness.dispose()
		}
	})

	it("is fenced to its own scope family", async () => {
		const harness = makeHarness({})
		try {
			// Everything the widget's data is *composed* from, and still a 403:
			// this is what stops a device credential from being an org read key.
			const key = await harness.bootstrapKey(["error_issues:read", "services:read", "traces:read"])
			const summary = await harness.get(key.secret)
			expect(summary.status).toBe(403)
			expect(summary.body.error.message).toContain("widget_summary:read")
		} finally {
			await harness.dispose()
		}
	})

	it("applies deployment_environment to all three reads and echoes it", async () => {
		// Asserted per read rather than on the response alone: a filter that
		// reached the issues query but not the throughput one would still return a
		// plausible payload, with an error rate the traffic under it cannot make.
		let issuesEnv: string | undefined
		let catalogSql = ""
		const seriesEnvironments: Array<ReadonlyArray<string> | undefined> = []

		const harness = makeHarness({
			listIssues: (_orgId, opts) => {
				issuesEnv = opts.deploymentEnv
				return Effect.succeed(new ErrorIssuesListResponse({ issues: [issueDocument()] }))
			},
			warehouse: makeWarehouseServiceStub({
				compiledQuery: (_tenant, compiled) => {
					catalogSql = compiledQueryOf(compiled).sql
					return compiledQueryOf(compiled).decodeRows(
						compiledQueryOf(compiled).sql.includes("FROM service_overview_spans")
							? [serviceRow]
							: [],
					)
				},
				compiledQueryFirst: (_tenant, compiled) =>
					compiledQueryOf(compiled)
						.decodeRows([])
						.pipe(Effect.map((rows) => Option.fromNullishOr(rows[0]))),
				ingest: () => Effect.void,
			}) as WarehouseQueryService,
			queryEngine: queryEngineStub((tenant, request) => {
				seriesEnvironments.push(request.query.filters?.environments)
				return seriesEngine.execute(tenant, request)
			}),
		})
		try {
			const key = await harness.bootstrapKey(["widget_summary:read"])
			const summary = await harness.get(key.secret, {}, "?deployment_environment=staging")

			expect(summary.status).toBe(200)
			expect(issuesEnv).toBe("staging")
			expect(catalogSql).toContain("staging")
			// Both series — grouped and ungrouped — or the sparkline and the
			// headline it sits under would describe different populations.
			expect(seriesEnvironments).toHaveLength(2)
			expect(seriesEnvironments).toEqual([["staging"], ["staging"]])
			// Echoed so the client can prove the payload belongs to the snapshot
			// slot it is about to overwrite.
			expect(summary.body.deployment_environment).toBe("staging")
		} finally {
			await harness.dispose()
		}
	})

	it("reads the whole organization when no environment is given", async () => {
		let issuesEnv: string | undefined = "unset"
		const harness = makeHarness({
			listIssues: (_orgId, opts) => {
				issuesEnv = opts.deploymentEnv
				return Effect.succeed(new ErrorIssuesListResponse({ issues: [issueDocument()] }))
			},
		})
		try {
			const key = await harness.bootstrapKey(["widget_summary:read"])
			const summary = await harness.get(key.secret)

			expect(summary.status).toBe(200)
			expect(issuesEnv).toBeUndefined()
			// Null, not absent: widgets placed before the parameter existed keep
			// asking for the organization, and must be able to tell that apart from
			// a server that ignored their filter.
			expect(summary.body.deployment_environment).toBeNull()
		} finally {
			await harness.dispose()
		}
	})

	it("rejects an organization selection that disagrees with the key", async () => {
		const harness = makeHarness({})
		try {
			const key = await harness.bootstrapKey(["widget_summary:read"])
			const summary = await harness.get(key.secret, { "x-maple-org-id": "org_someone_else" })
			expect(summary.status).toBe(403)
		} finally {
			await harness.dispose()
		}
	})
})

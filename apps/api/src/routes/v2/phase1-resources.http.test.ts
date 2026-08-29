import { afterEach, describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Context, Effect, Layer, ManagedRuntime, Option, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import {
	ActorDocument,
	ActorId,
	AiTriageEvidence,
	AiTriageResult,
	AnomalyDetectorSettingsDocument,
	AnomalyIncidentDocument,
	AnomalyIncidentNotFoundError,
	AnomalyIncidentsListResponse,
	AnomalyIncidentId,
	AnomalyIncidentTimeseriesResponse,
	AnomalyTimeseriesBucket,
	ErrorIncidentDocument,
	ErrorIssueDetailResponse,
	ErrorIssueDocument,
	ErrorIssueId,
	ErrorIssueNotFoundError,
	ErrorPersistenceError,
	ErrorIssueSampleTrace,
	ErrorIssueEnvironment,
	ErrorIssuesListResponse,
	ErrorIssueTimeseriesPoint,
	InvestigationDocument,
	InvestigationFanout,
	InvestigationIncidentSubject,
	InvestigationNotFoundError,
	InvestigationSnapshotFact,
	InvestigationSnapshotReference,
	InvestigationSubjectSnapshot,
	InvestigationAgentUnavailableError,
	InvestigationsListResponse,
	InvestigationId,
	IsoDateTimeString,
	OrgId,
	SpanId,
	TraceId,
	UserId,
	OrgClickHouseSettingsEncryptionError,
	OrgClickHouseSettingsPersistenceError,
} from "@maple/domain/http"
import { MapleApiV2, encodePublicId } from "@maple/domain/http/v2"
import { WarehouseResponseLimitError } from "@maple/query-engine/execution"
import { cleanupTestDbs, createTestDb, type TestDb } from "@/platform/test-pglite"
import type { WarehouseQueryServiceApi } from "@/services/warehouse/WarehouseQueryService"
import { WarehouseQueryService } from "@/services/warehouse/WarehouseQueryService"
import { Env } from "@/platform/Env"
import { AnomalyDetectionService } from "@/services/alerts/AnomalyDetectionService"
import { ApiAuthorizationV2Layer } from "@/services/auth/ApiAuthorizationV2Layer"
import { AuditLogService } from "@/services/audit/AuditLogService"
import { ApiKeysService } from "@/services/org/ApiKeysService"
import { AuthService } from "@/services/auth/AuthService"
import { DashboardPersistenceService } from "@/services/dashboards/DashboardPersistenceService"
import { SharedDashboardService } from "@/services/dashboards/SharedDashboardService"
import { ErrorsService } from "@/services/errors/ErrorsService"
import { ErrorIssueReadModelsService } from "@/services/errors/ErrorIssueReadModelsService"
import { InvestigationService } from "@/services/errors/InvestigationService"
import { OrganizationService } from "@/services/org/OrganizationService"
import { V2TransportErrorBoundaryLive } from "./error-envelope"
import {
	AlertsServiceStubLayer,
	AllV2GroupLayersLive,
	ApiV2RateLimiterAllowAllLayer,
	ConfigResourceServiceStubsLayer,
	makeWarehouseServiceStub,
	PlanetScaleServiceStubsLayer,
	SlackIntegrationServiceStubLayer,
	TelemetryServiceStubsLayer,
} from "./v2-test-support"
import { compiledQueryOf } from "@maple/query-engine/execution"

/**
 * End-to-end HTTP tests for the Phase-1 remainder v2 groups (investigations,
 * anomalies, organization, session_replays). The backing services are stubbed
 * with fixtures so the tests assert the wire shape (snake_case, public IDs, list
 * envelope) and error mapping the handlers produce.
 */

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const decodeInvId = Schema.decodeSync(InvestigationId)
const decodeAnomId = Schema.decodeSync(AnomalyIncidentId)
const decodeActorId = Schema.decodeSync(ActorId)
const decodeIssueId = Schema.decodeSync(ErrorIssueId)
const decodeIso = Schema.decodeSync(IsoDateTimeString)
const decodeTraceId = Schema.decodeSync(TraceId)
const decodeSpanId = Schema.decodeSync(SpanId)

const INV_UUID = "11111111-1111-4111-8111-111111111111"
const MISSING_INV_UUID = "33333333-3333-4333-8333-333333333333"
const ANOM_UUID = "22222222-2222-4222-8222-222222222222"
const MISSING_ANOM_UUID = "44444444-4444-4444-8444-444444444444"
const ISS_UUID = "55555555-5555-4555-8555-555555555555"
const ACTOR_UUID = "66666666-6666-4666-8666-666666666666"
const ERROR_INCIDENT_UUID = "77777777-7777-4777-8777-777777777777"
const INV_UUID_2 = "88888888-8888-4888-8888-888888888888"
const INV_UUID_3 = "99999999-9999-4999-8999-999999999999"
const CORRUPT_INV_UUID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const ANOM_UUID_2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const ANOM_UUID_3 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

const INV_ID = encodePublicId("inv", INV_UUID)
const MISSING_INV_ID = encodePublicId("inv", MISSING_INV_UUID)
const ANOM_ID = encodePublicId("anom", ANOM_UUID)
const MISSING_ANOM_ID = encodePublicId("anom", MISSING_ANOM_UUID)
const ISS_ID = encodePublicId("iss", ISS_UUID)
const ACTOR_ID = encodePublicId("actor", ACTOR_UUID)
const ERROR_INCIDENT_ID = encodePublicId("einc", ERROR_INCIDENT_UUID)
const CORRUPT_INV_ID = encodePublicId("inv", CORRUPT_INV_UUID)

const investigationFixture = new InvestigationDocument({
	id: decodeInvId(INV_UUID),
	status: "diagnosed",
	subject: new InvestigationIncidentSubject({
		type: "incident",
		incidentKind: "error",
		incidentId: ERROR_INCIDENT_UUID,
	}),
	snapshot: new InvestigationSubjectSnapshot({
		title: "Checkout failures",
		scope: "payments",
		status: "open",
		severity: "high",
		facts: [new InvestigationSnapshotFact({ label: "Service", value: "payments" })],
		references: [
			new InvestigationSnapshotReference({
				label: "Issue",
				url: `/errors/issues/${ISS_UUID}`,
			}),
		],
		incidentStartedAt: decodeIso("2026-07-15T09:10:00.000Z"),
		incidentEndedAt: null,
	}),
	report: new AiTriageResult({
		summary: "Checkout failures increased after a deploy.",
		suspectedCause: "A database connection pool regression.",
		severityAssessment: "high",
		affectedScope: "payments checkout",
		evidence: [
			new AiTriageEvidence({
				traceIds: ["0123456789abcdef0123456789abcdef"],
				logPatterns: ["connection pool exhausted"],
				relatedServices: ["payments", "postgres"],
				note: "Failures begin at the deployment boundary.",
			}),
		],
		suggestedActions: ["Roll back the pool change."],
		confidence: "high",
	}),
	model: "claude-opus-4-8",
	severity: "high",
	confidence: "high",
	seededBy: "system",
	createdBy: null,
	inputTokens: 120,
	outputTokens: 40,
	error: null,
	createdAt: decodeIso("2026-07-15T09:12:00.000Z"),
	startedAt: decodeIso("2026-07-15T09:12:05.000Z"),
	diagnosedAt: decodeIso("2026-07-15T09:12:42.000Z"),
	updatedAt: decodeIso("2026-07-15T09:12:42.000Z"),
	// Single-pass fixture: no lenses were dispatched, so nothing ranked them.
	lensRuns: [],
	validator: null,
	fanout: new InvestigationFanout({ state: "none", size: 1 }),
})

const corruptInvestigationFixture = new InvestigationDocument({
	...investigationFixture,
	id: decodeInvId(CORRUPT_INV_UUID),
	subject: new InvestigationIncidentSubject({
		type: "incident",
		incidentKind: "error",
		incidentId: "legacy-invalid-incident-id",
	}),
})

const anomalyFixture = new AnomalyIncidentDocument({
	id: decodeAnomId(ANOM_UUID),
	detectorKey: "error_rate:payments:production",
	signalType: "error_rate",
	serviceName: "payments",
	deploymentEnv: "production",
	fingerprintHash: null,
	errorIssueId: null,
	status: "open",
	severity: "critical",
	openedValue: 0.12,
	baselineMedian: 0.01,
	baselineSigma: 0.004,
	thresholdValue: 0.05,
	lastObservedValue: 0.14,
	lastSampleCount: 4200,
	firstTriggeredAt: decodeIso("2026-07-15T09:12:00.000Z"),
	lastTriggeredAt: decodeIso("2026-07-15T09:18:00.000Z"),
	resolvedAt: null,
	resolveReason: null,
	triageStatus: "completed",
	fingerprints: [],
	reopenCount: 0,
	lastReopenedAt: null,
})

const investigationFixtures = [
	investigationFixture,
	new InvestigationDocument({
		...investigationFixture,
		id: decodeInvId(INV_UUID_2),
	}),
	new InvestigationDocument({
		...investigationFixture,
		id: decodeInvId(INV_UUID_3),
	}),
]

const anomalyFixtures = [
	anomalyFixture,
	new AnomalyIncidentDocument({
		...anomalyFixture,
		id: decodeAnomId(ANOM_UUID_2),
	}),
	new AnomalyIncidentDocument({
		...anomalyFixture,
		id: decodeAnomId(ANOM_UUID_3),
	}),
]

const settingsFixture = new AnomalyDetectorSettingsDocument({
	enabled: true,
	sensitivity: "normal",
	mutedSignals: [],
	updatedAt: decodeIso("2026-07-15T09:12:00.000Z"),
	updatedBy: null,
})

const timeseriesFixture = new AnomalyIncidentTimeseriesResponse({
	signalType: "error_rate",
	unit: "ratio",
	bucketSeconds: 300,
	buckets: [
		new AnomalyTimeseriesBucket({
			bucket: decodeIso("2026-07-15T09:10:00.000Z"),
			value: 0.12,
			sampleCount: 4200,
		}),
	],
	baselineMedian: 0.01,
	thresholdValue: 0.05,
})

const actorFixture = new ActorDocument({
	id: decodeActorId(ACTOR_UUID),
	type: "user",
	userId: null,
	agentName: null,
	model: null,
	capabilities: [],
	lastActiveAt: null,
})

const errorIncidentFixture = new ErrorIncidentDocument({
	id: Schema.decodeSync(ErrorIncidentDocument.fields.id)(ERROR_INCIDENT_UUID),
	issueId: decodeIssueId(ISS_UUID),
	status: "open",
	reason: "first_seen",
	firstTriggeredAt: decodeIso("2026-07-15T09:12:00.000Z"),
	lastTriggeredAt: decodeIso("2026-07-15T09:18:00.000Z"),
	resolvedAt: null,
	occurrenceCount: 12,
})

const errorIssueFixture = new ErrorIssueDocument({
	id: decodeIssueId(ISS_UUID),
	kind: "error",
	fingerprintHash: "1234",
	serviceName: "checkout-api",
	exceptionType: "TimeoutError",
	exceptionMessage: "upstream timed out",
	errorLabel: "TimeoutError: upstream timed out",
	topFrame: "handler.ts:42",
	workflowState: "triage",
	priority: 0,
	severity: "critical",
	severitySource: "detector",
	sourceRef: null,
	assignedActor: actorFixture,
	leaseHolder: null,
	leaseExpiresAt: null,
	claimedAt: null,
	notes: null,
	firstSeenAt: decodeIso("2026-07-15T09:00:00.000Z"),
	lastSeenAt: decodeIso("2026-07-15T09:18:00.000Z"),
	occurrenceCount: 12,
	resolvedAt: null,
	lastResolvedAt: null,
	lastRegressedAt: null,
	regressionCount: 0,
	resolvedVersions: [],
	snoozeUntil: null,
	archivedAt: null,
	hasOpenIncident: true,
	commentCount: 0,
	openPullRequestCount: 0,
	mergedPullRequestCount: 0,
})

const errorIssueDetailFixture = new ErrorIssueDetailResponse({
	issue: errorIssueFixture,
	timeseries: [
		new ErrorIssueTimeseriesPoint({
			bucket: decodeIso("2026-07-15T09:00:00.000Z"),
			count: 12,
		}),
	],
	sampleTraces: [
		new ErrorIssueSampleTrace({
			traceId: decodeTraceId("0123456789abcdef0123456789abcdef"),
			spanId: decodeSpanId("0123456789abcdef"),
			serviceName: "checkout-api",
			timestamp: decodeIso("2026-07-15T09:18:00.000Z"),
			exceptionMessage: "upstream timed out",
			durationMicros: 1200,
		}),
	],
	incidents: [errorIncidentFixture],
	environments: [new ErrorIssueEnvironment({ name: "production", count: 12 })],
})

const die = () => Effect.die(new Error("not exercised in this test harness"))

/** Empty warehouse — enough to exercise the session_replays envelope + 404 paths. */
const warehouseStub = makeWarehouseServiceStub({
	rawSqlQuery: () => Effect.succeed([]),
	compiledQuery: (_tenant, compiled) => compiledQueryOf(compiled).decodeRows([]).pipe(Effect.orDie),
	// Replay payload reads go through the bounded variant (they carry an explicit
	// response-byte ceiling), so the stub has to answer it too.
	compiledQueryBounded: (_tenant, compiled) => compiledQueryOf(compiled).decodeRows([]).pipe(Effect.orDie),
	compiledQueryFirst: () => Effect.succeed(Option.none()),
	// Handlers warm the org route before fanning out; the real one resolves
	// route + capabilities, which this stub has nothing to resolve.
	warmRoute: () => Effect.void,
	ingest: () => Effect.void,
})

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
			INTERNAL_SERVICE_TOKEN: "test-internal-token",
		}),
	)

const ORG = Schema.decodeUnknownSync(OrgId)("org_phase1_e2e")
const USER = Schema.decodeUnknownSync(UserId)("user_phase1_e2e")

type InvestigationStartMode = "success" | "unavailable" | "restart_not_found"
type IssueReadFailure = "none" | "persistence" | "warehouse_config_lookup" | "warehouse_config_decryption"

const makeHarness = (
	warehouseService: WarehouseQueryServiceApi = warehouseStub,
	issueReadFailure: IssueReadFailure = "none",
	investigationStartMode: InvestigationStartMode = "success",
) => {
	const testDb = createTestDb(createdDbs)
	const envLive = Env.layer.pipe(Layer.provide(testConfig()))

	// Functional stubs for the groups under test — provided first so they win
	// over the inert stubs in ConfigResourceServiceStubsLayer.
	let lastIssueListCall: {
		readonly orgId: string
		readonly options: Record<string, unknown>
	} | null = null
	let lastIssueDetailCall: {
		readonly orgId: string
		readonly options: Record<string, unknown>
	} | null = null
	const issueReadFailureEffect = () => {
		switch (issueReadFailure) {
			case "warehouse_config_lookup":
				return Effect.fail(
					new OrgClickHouseSettingsPersistenceError({
						message: "SECRET_CONFIG_LOOKUP_FAILURE",
					}),
				)
			case "warehouse_config_decryption":
				return Effect.fail(
					new OrgClickHouseSettingsEncryptionError({
						message: "SECRET_DECRYPTION_FAILURE",
					}),
				)
			default:
				return Effect.fail(new ErrorPersistenceError({ message: "database unavailable" }))
		}
	}
	const startInvestigation = () => {
		switch (investigationStartMode) {
			case "unavailable":
				return Effect.fail(
					new InvestigationAgentUnavailableError({
						message: "Agent unavailable",
					}),
				)
			default:
				return Effect.succeed(investigationFixture)
		}
	}
	const functionalStubs = Layer.mergeAll(
		Layer.succeed(InvestigationService, {
			listInvestigations: (_org, options) => {
				const offset = options?.offset ?? 0
				return Effect.succeed(
					new InvestigationsListResponse({
						investigations: investigationFixtures.slice(offset, offset + (options?.limit ?? 100)),
					}),
				)
			},
			getInvestigation: (_org, id) =>
				id === investigationFixture.id
					? Effect.succeed(investigationFixture)
					: id === corruptInvestigationFixture.id
						? Effect.succeed(corruptInvestigationFixture)
						: Effect.fail(
								new InvestigationNotFoundError({
									message: `No such investigation: '${id}'`,
								}),
							),
			createInvestigation: () => Effect.succeed(investigationFixture),
			createAndStartInvestigation: startInvestigation,
			restartInvestigation: () =>
				investigationStartMode === "restart_not_found"
					? Effect.fail(
							new InvestigationNotFoundError({
								message: "No such investigation",
							}),
						)
					: startInvestigation(),
			updateStatus: () => Effect.succeed(investigationFixture),
			submitDiagnosis: die,
		}),
		Layer.succeed(AnomalyDetectionService, {
			runTick: die,
			listIncidents: (_org, options) => {
				const offset = options?.offset ?? 0
				return Effect.succeed(
					new AnomalyIncidentsListResponse({
						incidents: anomalyFixtures.slice(offset, offset + (options?.limit ?? 100)),
					}),
				)
			},
			getIncident: (_org, id) =>
				id === anomalyFixture.id
					? Effect.succeed(anomalyFixture)
					: Effect.fail(
							new AnomalyIncidentNotFoundError({
								message: `No such incident: '${id}'`,
								incidentId: id,
							}),
						),
			resolveIncidentManually: (_org, id) =>
				id === anomalyFixture.id
					? Effect.succeed(anomalyFixture)
					: Effect.fail(
							new AnomalyIncidentNotFoundError({
								message: `No such incident: '${id}'`,
								incidentId: id,
							}),
						),
			countIncidentsByService: () =>
				Effect.succeed([
					{
						serviceName: anomalyFixture.serviceName,
						deploymentEnv: anomalyFixture.deploymentEnv,
						signalType: anomalyFixture.signalType,
						severity: anomalyFixture.severity,
						incidentCount: anomalyFixtures.length,
						lastTriggeredAt: anomalyFixture.lastTriggeredAt,
					},
				]),
			setIncidentIssue: () => Effect.succeed({ incident: anomalyFixture, previousIssueId: null }),
			getIncidentTimeseries: () => Effect.succeed(timeseriesFixture),
			getSettings: () => Effect.succeed(settingsFixture),
			updateSettings: () => Effect.succeed(settingsFixture),
		}),
		Layer.succeed(ErrorIssueReadModelsService, {
			listIssues: (orgId, options) => {
				lastIssueListCall = { orgId, options }
				if (issueReadFailure !== "none") {
					return issueReadFailureEffect()
				}
				return Effect.succeed(new ErrorIssuesListResponse({ issues: [errorIssueFixture] }))
			},
			getIssue: (orgId, issueId, options) => {
				lastIssueDetailCall = { orgId, options }
				return issueReadFailure !== "none"
					? issueReadFailureEffect()
					: issueId === errorIssueFixture.id
						? Effect.succeed(errorIssueDetailFixture)
						: Effect.fail(ErrorIssueNotFoundError.forIssue(issueId))
			},
			countOpenIssuesByService: () => Effect.succeed([]),
			listIssueIncidents: die,
			listOpenIncidents: die,
		}),
		// The anomalies group still exercises the issue-link audit mutation.
		Layer.succeed(ErrorsService, {
			listIssues: die,
			countOpenIssuesByService: die,
			getIssue: die,
			transitionIssue: die,
			claimIssue: die,
			heartbeatIssue: die,
			releaseIssue: die,
			assignIssue: die,
			setSeverity: die,
			commentOnIssue: die,
			proposeFix: die,
			listIssueEvents: die,
			registerAgent: die,
			listAgents: die,
			lookupActor: die,
			ensureUserActor: () => Effect.succeed(actorFixture),
			recordAnomalyLinkEvent: () => Effect.void,
			listIssueIncidents: die,
			listOpenIncidents: die,
			getNotificationPolicy: die,
			upsertNotificationPolicy: die,
			getEscalationPolicy: die,
			upsertEscalationPolicy: die,
			evaluateEscalationPolicy: die,
			listIssueEscalations: die,
			listRecentEscalations: die,
			runTick: die,
		}),
		Layer.succeed(OrganizationService, {
			retrieve: (orgId) =>
				Effect.succeed({
					id: orgId,
					name: "Acme Inc",
					slug: "acme",
					createdAtMs: Date.parse("2026-01-15T12:00:00.000Z"),
				}),
			delete: die,
		}),
		Layer.succeed(WarehouseQueryService, warehouseService),
	)

	const servicesLive = Layer.mergeAll(
		ApiKeysService.layer,
		AuthService.layer,
		DashboardPersistenceService.layer,
		SharedDashboardService.layer,
	).pipe(Layer.provideMerge(Layer.mergeAll(envLive, testDb.layer)))

	const routes = HttpApiBuilder.layer(MapleApiV2).pipe(
		Layer.provide(AllV2GroupLayersLive),
		Layer.provide(functionalStubs),
		Layer.provide(V2TransportErrorBoundaryLive),
		Layer.provide(SlackIntegrationServiceStubLayer),
		Layer.provide(PlanetScaleServiceStubsLayer),
		Layer.provide(AlertsServiceStubLayer),
		Layer.provide(ConfigResourceServiceStubsLayer),
		Layer.provide(TelemetryServiceStubsLayer),
		Layer.provideMerge(ApiAuthorizationV2Layer),
		Layer.provideMerge(AuditLogService.layer),
		Layer.provideMerge(ApiV2RateLimiterAllowAllLayer),
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
					...(options.token !== undefined
						? { authorization: `Bearer ${options.token}` }
						: undefined),
					...(options.body !== undefined ? { "content-type": "application/json" } : undefined),
				},
				body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
			}),
			Context.empty() as never,
		)
		const text = await response.text()
		return {
			status: response.status,
			headers: response.headers,
			body: text.length > 0 ? JSON.parse(text) : null,
		}
	}

	const bootstrapKey = (scopes?: ReadonlyArray<string>) =>
		runtime.runPromise(
			Effect.gen(function* () {
				const service = yield* ApiKeysService
				return yield* service.create(ORG, USER, {
					name: "phase1-test",
					scopes,
				})
			}),
		)

	return {
		request,
		bootstrapKey,
		lastIssueListCall: () => lastIssueListCall,
		lastIssueDetailCall: () => lastIssueDetailCall,
		dispose: async () => {
			await disposeHandler()
			await runtime.dispose()
		},
	}
}

describe("v2 error_issues over HTTP", () => {
	it("lists bounded actionable service issues and retrieves rich detail", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey(["error_issues:read"])
		const list = await harness.request(
			"GET",
			"/v2/error_issues?service_name=checkout-api&actionable=true&sort=severity&limit=5",
			{ token: key.secret },
		)
		expect(list.status).toBe(200)
		expect(list.body).toMatchObject({
			object: "list",
			has_more: false,
			next_cursor: null,
		})
		expect(list.body.data[0]).toMatchObject({
			id: ISS_ID,
			object: "error_issue",
			service_name: "checkout-api",
			severity: "critical",
			has_open_incident: true,
			assigned_actor: { id: ACTOR_ID },
		})
		expect(harness.lastIssueListCall()).toMatchObject({
			orgId: ORG,
			options: {
				service: "checkout-api",
				actionable: true,
				sort: "severity",
				limit: 5,
			},
		})

		const detail = await harness.request(
			"GET",
			`/v2/error_issues/${ISS_ID}?start_time=2026-07-15T00%3A00%3A00.000Z&end_time=2026-07-16T00%3A00%3A00.000Z&bucket_seconds=300&sample_limit=10`,
			{ token: key.secret },
		)
		expect(detail.status).toBe(200)
		expect(detail.body.id).toBe(ISS_ID)
		expect(detail.body.timeseries[0].count).toBe(12)
		expect(detail.body.sample_traces[0].trace_id).toBe("0123456789abcdef0123456789abcdef")
		expect(detail.body.incidents[0].id).toBe(ERROR_INCIDENT_ID)
		expect(harness.lastIssueDetailCall()).toMatchObject({
			orgId: ORG,
			options: {
				startTime: "2026-07-15T00:00:00.000Z",
				endTime: "2026-07-16T00:00:00.000Z",
				bucketSeconds: 300,
				sampleLimit: 10,
			},
		})
		await harness.dispose()
	})

	it("enforces scope, validates cursor sort, and maps missing issues to 404", async () => {
		const harness = makeHarness()
		const wrongScope = await harness.bootstrapKey(["dashboards:read"])
		const forbidden = await harness.request("GET", "/v2/error_issues", {
			token: wrongScope.secret,
		})
		expect(forbidden.status).toBe(403)

		const key = await harness.bootstrapKey(["error_issues:read"])
		const mismatch = await harness.request(
			"GET",
			`/v2/error_issues?sort=severity&cursor=${encodeURIComponent("not-a-severity-cursor")}`,
			{ token: key.secret },
		)
		expect(mismatch.status).toBe(400)
		expect(mismatch.body.error.code).toBe("cursor_sort_mismatch")

		const invalidActionable = await harness.request("GET", "/v2/error_issues?actionable=false", {
			token: key.secret,
		})
		expect(invalidActionable.status).toBe(400)
		const overLimit = await harness.request("GET", "/v2/error_issues?limit=101", {
			token: key.secret,
		})
		expect(overLimit.status).toBe(400)

		const missingId = encodePublicId("iss", "99999999-9999-4999-8999-999999999991")
		const missing = await harness.request("GET", `/v2/error_issues/${missingId}`, { token: key.secret })
		expect(missing.status).toBe(404)
		expect(missing.body.error.code).toBe("error_issue_not_found")
		await harness.dispose()
	})

	it("maps list and rich-retrieve dependency failures to v2 503 errors", async () => {
		const harness = makeHarness(warehouseStub, "persistence")
		const key = await harness.bootstrapKey(["error_issues:read"])
		const list = await harness.request("GET", "/v2/error_issues", {
			token: key.secret,
		})
		expect(list.status).toBe(503)
		expect(list.body.error.type).toBe("api_error")

		const detail = await harness.request("GET", `/v2/error_issues/${ISS_ID}`, {
			token: key.secret,
		})
		expect(detail.status).toBe(503)
		expect(detail.body.error.type).toBe("api_error")
		await harness.dispose()
	})

	it("preserves exact warehouse failures instead of relabeling them as persistence", async () => {
		const harness = makeHarness(warehouseStub, "warehouse_config_lookup")
		const key = await harness.bootstrapKey(["error_issues:read"])
		const response = await harness.request("GET", "/v2/error_issues", { token: key.secret })

		expect(response.status).toBe(503)
		expect(response.body.error).toMatchObject({
			_tag: "@maple/http/errors/OrgClickHouseSettingsPersistenceError",
			code: "clickhouse_settings_unavailable",
			retryable: true,
			recovery: "retry",
		})
		expect(JSON.stringify(response.body)).not.toContain("SECRET_CONFIG_LOOKUP_FAILURE")
		await harness.dispose()
	})

	it("preserves and redacts a non-retryable warehouse configuration failure", async () => {
		const harness = makeHarness(warehouseStub, "warehouse_config_decryption")
		const key = await harness.bootstrapKey(["error_issues:read"])
		const response = await harness.request("GET", "/v2/error_issues", { token: key.secret })

		expect(response.status).toBe(500)
		expect(response.body.error).toMatchObject({
			_tag: "@maple/http/errors/OrgClickHouseSettingsEncryptionError",
			code: "clickhouse_settings_encryption_failed",
			retryable: false,
			recovery: "contact_support",
		})
		expect(JSON.stringify(response.body)).not.toContain("SECRET_DECRYPTION_FAILURE")
		await harness.dispose()
	})
})

describe("v2 investigations over HTTP", () => {
	it("lists and retrieves with wire shapes", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey()

		const list = await harness.request("GET", "/v2/investigations", {
			token: key.secret,
		})
		expect(list.status).toBe(200)
		expect(list.body.object).toBe("list")
		expect(list.body.data).toHaveLength(3)
		expect(list.body.data[0].id).toBe(INV_ID)
		expect(list.body.data[0].object).toBe("investigation")
		expect(list.body.data[0].seeded_by).toBe("system")
		expect(list.body.data[0].subject).toEqual({
			type: "incident",
			incident_kind: "error",
			incident_id: ERROR_INCIDENT_ID,
			issue_id: null,
		})
		expect(list.body.data[0].snapshot).toEqual({
			title: "Checkout failures",
			scope: "payments",
			status: "open",
			severity: "high",
			facts: [{ label: "Service", value: "payments" }],
			references: [{ label: "Issue", url: `/errors/issues/${ISS_UUID}` }],
			incident_started_at: "2026-07-15T09:10:00.000Z",
			incident_ended_at: null,
		})
		expect(list.body.data[0].report).toEqual({
			summary: "Checkout failures increased after a deploy.",
			suspected_cause: "A database connection pool regression.",
			severity_assessment: "high",
			affected_scope: "payments checkout",
			evidence: [
				{
					trace_ids: ["0123456789abcdef0123456789abcdef"],
					log_patterns: ["connection pool exhausted"],
					related_services: ["payments", "postgres"],
					note: "Failures begin at the deployment boundary.",
				},
			],
			suggested_actions: ["Roll back the pool change."],
			confidence: "high",
		})
		expect(list.body.data[0].created_at).toBe("2026-07-15T09:12:00.000Z")

		const got = await harness.request("GET", `/v2/investigations/${INV_ID}`, {
			token: key.secret,
		})
		expect(got.status).toBe(200)
		expect(got.body.id).toBe(INV_ID)
		await harness.dispose()
	})

	it("sanitizes a corrupt legacy investigation subject", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey()
		const response = await harness.request("GET", `/v2/investigations/${CORRUPT_INV_ID}`, {
			token: key.secret,
		})
		expect(response.status).toBe(500)
		expect(response.body.error).toMatchObject({
			_tag: "@maple/http/investigations/InvestigationDataCorruptionError",
			type: "api_error",
			code: "investigation_data_corrupt",
		})
		expect(JSON.stringify(response.body)).not.toContain("legacy-invalid-incident-id")
		await harness.dispose()
	})

	it("maps a missing investigation to not_found_error", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey()

		const missing = await harness.request("GET", `/v2/investigations/${MISSING_INV_ID}`, {
			token: key.secret,
		})
		expect(missing.status).toBe(404)
		expect(missing.body.error.type).toBe("not_found_error")
		expect(missing.body.error.code).toBe("investigation_not_found")
		await harness.dispose()
	})

	it("creates from incident and freeform subjects and updates status", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey()

		// Incident subject: exercises the wire→internal subject mapper (with iss_ id).
		const createdIncident = await harness.request("POST", "/v2/investigations", {
			token: key.secret,
			body: {
				subject: {
					type: "incident",
					incident_kind: "error",
					incident_id: ERROR_INCIDENT_ID,
					issue_id: ISS_ID,
				},
			},
		})
		expect(createdIncident.status).toBe(200)
		expect(createdIncident.body.object).toBe("investigation")

		// Freeform subject: exercises the other union branch (context_refs passthrough).
		const createdFreeform = await harness.request("POST", "/v2/investigations", {
			token: key.secret,
			body: {
				subject: {
					type: "freeform",
					title: "why slow",
					prompt: "investigate p99",
					context_refs: [{ kind: "service", name: "payments" }],
				},
			},
		})
		expect(createdFreeform.status).toBe(200)

		const updated = await harness.request("POST", `/v2/investigations/${INV_ID}/status`, {
			token: key.secret,
			body: { status: "resolved" },
		})
		expect(updated.status).toBe(200)
		expect(updated.body.object).toBe("investigation")
		await harness.dispose()
	})

	it("restarts an investigation and maps a missing restart target", async () => {
		const successHarness = makeHarness()
		const successKey = await successHarness.bootstrapKey()
		const restarted = await successHarness.request("POST", `/v2/investigations/${INV_ID}/restart`, {
			token: successKey.secret,
		})
		expect(restarted.status).toBe(200)
		expect(restarted.body.id).toBe(INV_ID)
		await successHarness.dispose()

		const missingHarness = makeHarness(warehouseStub, false, "restart_not_found")
		const missingKey = await missingHarness.bootstrapKey()
		const missing = await missingHarness.request("POST", `/v2/investigations/${MISSING_INV_ID}/restart`, {
			token: missingKey.secret,
		})
		expect(missing.status).toBe(404)
		expect(missing.body.error.code).toBe("investigation_not_found")
		await missingHarness.dispose()
	})

	it("preserves the exact unavailable-start failure", async () => {
		const createBody = {
			subject: {
				type: "freeform",
				title: "quota test",
				prompt: "investigate",
				context_refs: [],
			},
		}

		const unavailableHarness = makeHarness(warehouseStub, false, "unavailable")
		const unavailableKey = await unavailableHarness.bootstrapKey()
		const unavailable = await unavailableHarness.request("POST", "/v2/investigations", {
			token: unavailableKey.secret,
			body: createBody,
		})
		expect(unavailable.status).toBe(503)
		expect(unavailable.body.error.code).toBe("investigation_agent_unavailable")
		expect(unavailable.body.error._tag).toBe(
			"@maple/http/investigations/InvestigationAgentUnavailableError",
		)
		expect(unavailable.body.error.retryable).toBe(true)
		await unavailableHarness.dispose()
	})
})

describe("v2 anomalies over HTTP", () => {
	it("lists incidents and reads settings with wire shapes", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey()

		const list = await harness.request("GET", "/v2/anomalies/incidents", {
			token: key.secret,
		})
		expect(list.status).toBe(200)
		expect(list.body.object).toBe("list")
		expect(list.body.data[0].id).toBe(ANOM_ID)
		expect(list.body.data[0].object).toBe("anomaly_incident")
		expect(list.body.data[0].signal_type).toBe("error_rate")
		expect(list.body.data[0].error_issue_id).toBeNull()
		expect(list.body.data[0].baseline_median).toBe(0.01)

		const settings = await harness.request("GET", "/v2/anomalies/settings", {
			token: key.secret,
		})
		expect(settings.status).toBe(200)
		expect(settings.body.object).toBe("anomaly_settings")
		expect(settings.body.enabled).toBe(true)
		expect(settings.body.muted_signals).toEqual([])
		await harness.dispose()
	})

	// The static aggregate path shares a prefix with `/incidents/:id`, so this
	// also pins that it is not swallowed by the param route as a public ID.
	it("aggregates incidents by service without paging the list", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey()

		const counts = await harness.request("GET", "/v2/anomalies/incidents/service_counts", {
			token: key.secret,
		})
		expect(counts.status).toBe(200)
		expect(counts.body.object).toBe("list")
		expect(counts.body.has_more).toBe(false)
		expect(counts.body.next_cursor).toBeNull()
		expect(counts.body.data[0]).toEqual({
			object: "anomaly_service_count",
			service_name: "payments",
			deployment_env: "production",
			signal_type: "error_rate",
			severity: "critical",
			incident_count: 3,
			last_triggered_at: "2026-07-15T09:18:00.000Z",
		})
		await harness.dispose()
	})

	it("retrieves a single incident, its timeseries, and 404s a missing one", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey()

		const got = await harness.request("GET", `/v2/anomalies/incidents/${ANOM_ID}`, { token: key.secret })
		expect(got.status).toBe(200)
		expect(got.body.id).toBe(ANOM_ID)
		expect(got.body.fingerprints).toEqual([])
		expect(got.body.first_triggered_at).toBe("2026-07-15T09:12:00.000Z")

		const ts = await harness.request("GET", `/v2/anomalies/incidents/${ANOM_ID}/timeseries`, {
			token: key.secret,
		})
		expect(ts.status).toBe(200)
		expect(ts.body.object).toBe("anomaly_incident.timeseries")
		expect(ts.body.bucket_seconds).toBe(300)
		expect(ts.body.buckets[0].sample_count).toBe(4200)

		const missing = await harness.request("GET", `/v2/anomalies/incidents/${MISSING_ANOM_ID}`, {
			token: key.secret,
		})
		expect(missing.status).toBe(404)
		expect(missing.body.error.type).toBe("not_found_error")
		await harness.dispose()
	})

	it("resolves an incident, links an issue (audit path), and updates settings (admin gate)", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey()

		const resolved = await harness.request("POST", `/v2/anomalies/incidents/${ANOM_ID}/resolve`, {
			token: key.secret,
		})
		expect(resolved.status).toBe(200)
		expect(resolved.body.object).toBe("anomaly_incident")

		// Exercises the ensureUserActor + recordAnomalyLinkEvent enrichment.
		const linked = await harness.request("PUT", `/v2/anomalies/incidents/${ANOM_ID}/issue`, {
			token: key.secret,
			body: { issue_id: ISS_ID },
		})
		expect(linked.status).toBe(200)
		expect(linked.body.id).toBe(ANOM_ID)

		// API-key tenants are `root` → the admin gate passes.
		const updated = await harness.request("PATCH", "/v2/anomalies/settings", {
			token: key.secret,
			body: { sensitivity: "high" },
		})
		expect(updated.status).toBe(200)
		expect(updated.body.object).toBe("anomaly_settings")
		await harness.dispose()
	})
})

describe("v2 database-backed list pagination", () => {
	it("continues investigations and anomalies from the requested cursor", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey()

		for (const path of ["/v2/investigations", "/v2/anomalies/incidents"]) {
			const first = await harness.request("GET", `${path}?limit=1`, {
				token: key.secret,
			})
			expect(first.status).toBe(200)
			expect(first.body.data).toHaveLength(1)
			expect(first.body.has_more).toBe(true)
			expect(first.body.next_cursor).toMatch(/^off_/)

			const second = await harness.request("GET", `${path}?limit=1&cursor=${first.body.next_cursor}`, {
				token: key.secret,
			})
			expect(second.status).toBe(200)
			expect(second.body.data).toHaveLength(1)
			expect(second.body.data[0].id).not.toBe(first.body.data[0].id)
		}

		await harness.dispose()
	})
})

describe("v2 organization over HTTP", () => {
	it("retrieves the org identity with wire shape", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey()

		const org = await harness.request("GET", "/v2/organization", {
			token: key.secret,
		})
		expect(org.status).toBe(200)
		expect(org.body.object).toBe("organization")
		expect(org.body.id).toBe(ORG)
		expect(org.body.name).toBe("Acme Inc")
		expect(org.body.slug).toBe("acme")
		expect(org.body.created_at).toBe("2026-01-15T12:00:00.000Z")
		await harness.dispose()
	})
})

describe("v2 session_replays over HTTP", () => {
	it("returns an empty search envelope and 404s a missing session", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey()

		const search = await harness.request("POST", "/v2/session_replays/search", {
			token: key.secret,
			body: {
				start_time: "2026-07-15T00:00:00.000Z",
				end_time: "2026-07-16T00:00:00.000Z",
			},
		})
		expect(search.status).toBe(200)
		expect(search.body.object).toBe("list")
		expect(search.body.data).toEqual([])
		expect(search.body.has_more).toBe(false)
		expect(search.body.next_cursor).toBeNull()

		const missing = await harness.request(
			"GET",
			`/v2/session_replays/${encodePublicId("srep", "sess_missing")}`,
			{
				token: key.secret,
			},
		)
		expect(missing.status).toBe(404)
		expect(missing.body.error.type).toBe("not_found_error")
		await harness.dispose()
	})

	it("rejects a malformed timestamp with invalid_request_error", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey()

		const bad = await harness.request("POST", "/v2/session_replays/search", {
			token: key.secret,
			body: { start_time: "not-a-date", end_time: "2026-07-16T00:00:00.000Z" },
		})
		expect(bad.status).toBe(400)
		expect(bad.body.error.type).toBe("invalid_request_error")
		await harness.dispose()
	})

	it("allows read-scoped keys on search and for_trace, and rejects malformed cursors", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey(["session_replays:read"])
		const window = {
			start_time: "2026-07-15T00:00:00.000Z",
			end_time: "2026-07-16T00:00:00.000Z",
		}

		const search = await harness.request("POST", "/v2/session_replays/search", {
			token: key.secret,
			body: window,
		})
		expect(search.status).toBe(200)

		const forTrace = await harness.request("POST", "/v2/session_replays/for_trace", {
			token: key.secret,
			body: { ...window, trace_id: "0123456789abcdef0123456789abcdef" },
		})
		expect(forTrace.status).toBe(200)
		expect(forTrace.body).toMatchObject({
			object: "list",
			data: [],
			has_more: false,
		})

		const invalidCursor = await harness.request("POST", "/v2/session_replays/for_trace", {
			token: key.secret,
			body: {
				...window,
				trace_id: "0123456789abcdef0123456789abcdef",
				cursor: "garbage",
			},
		})
		expect(invalidCursor.status).toBe(400)
		expect(invalidCursor.body.error.code).toBe("parameter_invalid")
		await harness.dispose()
	})

	it("paginates transcripts beyond the query engine's old 100-row default", async () => {
		const transcriptRows = Array.from({ length: 105 }, (_, seq) => ({
			timestamp: `2026-07-15T09:12:${String(seq % 60).padStart(2, "0")}.000Z`,
			seq,
			type: seq % 2 === 0 ? "navigation" : "network",
			url: "https://example.com",
			traceId: "",
			level: "",
			message: "",
			targetSelector: "",
			targetText: "",
			netMethod: seq % 2 === 0 ? "" : "GET",
			netUrl: seq % 2 === 0 ? "" : "https://example.com/api",
			netStatus: seq % 2 === 0 ? 0 : 200,
			netDurationMs: seq % 2 === 0 ? 0 : 12,
			errorStack: "",
			// The transcript query also selects the custom-event props. Rows decode
			// against the compiled query's derived schema, so the fixture carries
			// every column the SELECT names.
			attributes: "{}",
		}))
		const transcriptWarehouse: WarehouseQueryServiceApi = {
			...warehouseStub,
			compiledQuery: (_tenant, compiled, options) => {
				if (options?.context !== "v2SessionTranscript") {
					return compiledQueryOf(compiled).decodeRows([]).pipe(Effect.orDie)
				}
				const match = /LIMIT\s+(\d+)\s+OFFSET\s+(\d+)/i.exec(compiledQueryOf(compiled).sql)
				const limit = Number(match?.[1] ?? 100)
				const offset = Number(match?.[2] ?? 0)
				return compiledQueryOf(compiled)
					.decodeRows(transcriptRows.slice(offset, offset + limit))
					.pipe(Effect.orDie)
			},
		}
		const harness = makeHarness(transcriptWarehouse)
		const key = await harness.bootstrapKey()
		const sessionId = encodePublicId("srep", "sess_105_events")

		const first = await harness.request("GET", `/v2/session_replays/${sessionId}/transcript?limit=100`, {
			token: key.secret,
		})
		expect(first.status).toBe(200)
		expect(first.body.data).toHaveLength(100)
		expect(first.body.has_more).toBe(true)
		expect(first.body.data[0].level).toBeNull()
		expect(first.body.data[0].net_status).toBeNull()

		const second = await harness.request(
			"GET",
			`/v2/session_replays/${sessionId}/transcript?limit=100&cursor=${encodeURIComponent(first.body.next_cursor)}`,
			{ token: key.secret },
		)
		expect(second.status).toBe(200)
		expect(second.body.data).toHaveLength(5)
		expect(second.body.data[0].seq).toBe(100)
		expect(second.body.has_more).toBe(false)
		expect(second.body.next_cursor).toBeNull()
		await harness.dispose()
	})

	it("404s events and transcript when the parent session does not exist", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey()
		const missingId = encodePublicId("srep", "sess_missing")

		for (const child of ["events", "transcript"]) {
			const response = await harness.request("GET", `/v2/session_replays/${missingId}/${child}`, {
				token: key.secret,
			})
			expect(response.status).toBe(404)
			expect(response.body.error.type).toBe("not_found_error")
		}
		await harness.dispose()
	})

	// A session's rrweb payload is unbounded by construction — ingest accepts up
	// to 1 GiB and the p99 is ~594 MB. Reading it all at once buffered the whole
	// payload into a 128 MB Worker; the abort was classified as a transient
	// warehouse fault, retried twice more, and returned "service unavailable".
	// These pin the shape that replaced it.
	describe("bounded replay reads", () => {
		const chunkRows = Array.from({ length: 40 }, (_, seq) => ({
			chunkSeq: seq,
			timestamp: "2026-05-26 08:29:26.243",
			durationMs: 5_000,
			eventCount: 10,
			byteSize: 100_000,
			events: "[]",
			isCheckpoint: seq % 20 === 0 ? 1 : 0,
		}))

		/** Serves rows honouring the ChunkSeq predicates + LIMIT/OFFSET in the SQL. */
		const chunkWarehouse = (): WarehouseQueryServiceApi => {
			const serve = (sql: string) => {
				const from = Number(/ChunkSeq >= (\d+)/.exec(sql)?.[1] ?? 0)
				const to = Number(/ChunkSeq <= (\d+)/.exec(sql)?.[1] ?? Number.MAX_SAFE_INTEGER)
				const limit = Number(/LIMIT\s+(\d+)/i.exec(sql)?.[1] ?? chunkRows.length)
				const offset = Number(/OFFSET\s+(\d+)/i.exec(sql)?.[1] ?? 0)
				return chunkRows
					.filter((row) => row.chunkSeq >= from && row.chunkSeq <= to)
					.slice(offset, offset + limit)
			}
			return {
				...warehouseStub,
				compiledQuery: (_tenant, compiled) =>
					compiledQueryOf(compiled)
						.decodeRows(serve(compiledQueryOf(compiled).sql))
						.pipe(Effect.orDie),
				compiledQueryBounded: (_tenant, compiled) =>
					compiledQueryOf(compiled)
						.decodeRows(serve(compiledQueryOf(compiled).sql))
						.pipe(Effect.orDie),
			}
		}

		it("serves a manifest with no payloads, and the caps a client must size against", async () => {
			const harness = makeHarness(chunkWarehouse())
			const key = await harness.bootstrapKey()
			const sessionId = encodePublicId("srep", "sess_manifest")

			const response = await harness.request("GET", `/v2/session_replays/${sessionId}/manifest`, {
				token: key.secret,
			})
			expect(response.status).toBe(200)
			expect(response.body.object).toBe("session_replay.manifest")
			expect(response.body.chunk_count).toBe(40)
			expect(response.body.total_byte_size).toBe(4_000_000)
			expect(response.body.truncated).toBe(false)
			// The whole point: the timeline arrives without the payload.
			expect(response.body.chunks[0]).not.toHaveProperty("events")
			// Playback anchors on the recording's own clock, not the receipt time.
			expect(response.body.chunks[0].is_checkpoint).toBe(true)
			// Echoed so a client never hardcodes a cap that can drift from ours.
			expect(response.body.max_chunks_per_request).toBe(40)
			await harness.dispose()
		})

		it("returns only the requested chunk range", async () => {
			const harness = makeHarness(chunkWarehouse())
			const key = await harness.bootstrapKey()
			const sessionId = encodePublicId("srep", "sess_ranged")

			const response = await harness.request(
				"GET",
				`/v2/session_replays/${sessionId}/events?from_chunk_seq=16&to_chunk_seq=31&limit=16`,
				{ token: key.secret },
			)
			expect(response.status).toBe(200)
			expect(response.body.data).toHaveLength(16)
			expect(response.body.data[0].chunk_seq).toBe(16)
			expect(response.body.data[15].chunk_seq).toBe(31)
			await harness.dispose()
		})

		it("clamps a range wider than the per-request cap instead of rejecting it", async () => {
			// One chunk over the cap should still return data — only an oversized
			// *payload* is refused, and that is the warehouse's call, not arithmetic.
			const harness = makeHarness(chunkWarehouse())
			const key = await harness.bootstrapKey()
			const sessionId = encodePublicId("srep", "sess_clamped")

			const response = await harness.request(
				"GET",
				`/v2/session_replays/${sessionId}/events?from_chunk_seq=0&to_chunk_seq=9999&limit=100`,
				{ token: key.secret },
			)
			expect(response.status).toBe(200)
			expect(response.body.data.length).toBeLessThanOrEqual(40)
			expect(response.body.data[0].chunk_seq).toBe(0)
			await harness.dispose()
		})

		it("serves a session that never produced a checkpoint", async () => {
			// The SDK's over-cap buffer guard drops the batch holding the opening
			// snapshot, so some existing recordings have no checkpoint anywhere.
			// The manifest must still describe them — the client anchors on chunk 0.
			const legacyRows = chunkRows.map((row) => ({ ...row, isCheckpoint: 0 }))
			const harness = makeHarness({
				...warehouseStub,
				compiledQuery: (_tenant, compiled) =>
					compiledQueryOf(compiled).decodeRows(legacyRows).pipe(Effect.orDie),
				compiledQueryBounded: (_tenant, compiled) =>
					compiledQueryOf(compiled).decodeRows(legacyRows).pipe(Effect.orDie),
			})
			const key = await harness.bootstrapKey()
			const sessionId = encodePublicId("srep", "sess_legacy")

			const response = await harness.request("GET", `/v2/session_replays/${sessionId}/manifest`, {
				token: key.secret,
			})
			expect(response.status).toBe(200)
			expect(response.body.chunk_count).toBe(40)
			expect(response.body.chunks.every((c: { is_checkpoint: boolean }) => !c.is_checkpoint)).toBe(true)
			await harness.dispose()
		})

		it("coerces JSON-quoted 64-bit ints from the ClickHouse wire format", async () => {
			// Backends that refuse `output_format_json_quote_64bit_integers=0` return
			// UInt64s as strings. Schema.Number rejects those, which would surface as
			// a bodyless 500 — hence the Number() coercion in both handlers.
			const quotedRows = chunkRows.slice(0, 2).map((row) => ({
				...row,
				byteSize: String(row.byteSize) as number,
				eventCount: String(row.eventCount) as number,
			}))
			const harness = makeHarness({
				...warehouseStub,
				compiledQuery: (_tenant, compiled) =>
					compiledQueryOf(compiled).decodeRows(quotedRows).pipe(Effect.orDie),
				compiledQueryBounded: (_tenant, compiled) =>
					compiledQueryOf(compiled).decodeRows(quotedRows).pipe(Effect.orDie),
			})
			const key = await harness.bootstrapKey()
			const sessionId = encodePublicId("srep", "sess_quoted")

			const manifest = await harness.request("GET", `/v2/session_replays/${sessionId}/manifest`, {
				token: key.secret,
			})
			expect(manifest.status).toBe(200)
			expect(manifest.body.total_byte_size).toBe(200_000)

			const events = await harness.request(
				"GET",
				`/v2/session_replays/${sessionId}/events?from_chunk_seq=0&to_chunk_seq=1`,
				{ token: key.secret },
			)
			expect(events.status).toBe(200)
			expect(events.body.data[0].byte_size).toBe(100_000)
			await harness.dispose()
		})

		it("keeps pagination honest when the caller asks for more than the cap", async () => {
			// `limit=100` is inside the public 1–100 range but above the per-request
			// chunk cap. Unclamped, the lookahead asks for 101 rows, gets the SQL
			// cap of 41, and concludes 41 <= 100 means "no more pages" — a short
			// page reported as complete, silently dropping the rest of the session.
			// 60 chunks: more than one capped page, so a page that claims to be the
			// last one is provably wrong.
			const manyRows = Array.from({ length: 60 }, (_, seq) => ({
				...chunkRows[0]!,
				chunkSeq: seq,
			}))
			const harness = makeHarness({
				...warehouseStub,
				compiledQueryBounded: (_tenant, compiled) => {
					const limit = Number(
						/LIMIT\s+(\d+)/i.exec(compiledQueryOf(compiled).sql)?.[1] ?? manyRows.length,
					)
					const offset = Number(/OFFSET\s+(\d+)/i.exec(compiledQueryOf(compiled).sql)?.[1] ?? 0)
					return compiledQueryOf(compiled)
						.decodeRows(manyRows.slice(offset, offset + limit))
						.pipe(Effect.orDie)
				},
			})
			const key = await harness.bootstrapKey()
			const sessionId = encodePublicId("srep", "sess_bigpage")

			const response = await harness.request(
				"GET",
				`/v2/session_replays/${sessionId}/events?limit=100`,
				{ token: key.secret },
			)
			expect(response.status).toBe(200)
			expect(response.body.data.length).toBeLessThanOrEqual(40)
			// 60 chunks exist and the page is capped at 40, so there is a next page.
			expect(response.body.has_more).toBe(true)
			expect(response.body.next_cursor).not.toBeNull()
			await harness.dispose()
		})

		it("refuses an over-budget range of blob-backed chunks before hydrating", async () => {
			// The seam between this change and the R2 move. Once payloads live in
			// the blob store the warehouse response is only an index — `events` is
			// "" — so the `responseLimits` ceiling on that read measures almost
			// nothing and would wave this through. `byteSize` is the uncompressed
			// payload size and is right there in the index, so the range is refused
			// without fetching a single object.
			const hugeBlobRows = chunkRows.slice(0, 4).map((row) => ({
				...row,
				events: "",
				byteSize: 5_000_000,
			}))
			const harness = makeHarness({
				...warehouseStub,
				compiledQueryBounded: (_tenant, compiled) =>
					compiledQueryOf(compiled).decodeRows(hugeBlobRows).pipe(Effect.orDie),
			})
			const key = await harness.bootstrapKey()
			const sessionId = encodePublicId("srep", "sess_blobs_toobig")

			const response = await harness.request(
				"GET",
				`/v2/session_replays/${sessionId}/events?from_chunk_seq=0&to_chunk_seq=3`,
				{ token: key.secret },
			)
			expect(response.status).toBe(413)
			expect(response.body.error.code).toBe("range_too_large")
			await harness.dispose()
		})

		it("serves a blob-backed range that fits the budget", async () => {
			const blobRows = chunkRows.slice(0, 4).map((row) => ({ ...row, events: "", byteSize: 100_000 }))
			const harness = makeHarness({
				...warehouseStub,
				compiledQueryBounded: (_tenant, compiled) =>
					compiledQueryOf(compiled).decodeRows(blobRows).pipe(Effect.orDie),
			})
			const key = await harness.bootstrapKey()
			const sessionId = encodePublicId("srep", "sess_blobs_ok")

			const response = await harness.request(
				"GET",
				`/v2/session_replays/${sessionId}/events?from_chunk_seq=0&to_chunk_seq=3`,
				{ token: key.secret },
			)
			expect(response.status).toBe(200)
			expect(response.body.data).toHaveLength(4)
			// No R2 binding in tests, so hydration is a no-op passthrough — the
			// point here is that the budget guard let the range through.
			expect(response.body.data[0].byte_size).toBe(100_000)
			await harness.dispose()
		})

		it("refuses an over-budget range with 413 range_too_large, not a 503", async () => {
			// The regression that motivated all of this: the old failure claimed the
			// database was unavailable and invited a retry that could only fail the
			// same way. This one names the cause and says what to change.
			const harness = makeHarness({
				...warehouseStub,
				compiledQueryBounded: () =>
					Effect.fail(
						new WarehouseResponseLimitError({
							kind: "bytes",
							message: "response too large",
						}),
					),
			})
			const key = await harness.bootstrapKey()
			const sessionId = encodePublicId("srep", "sess_toobig")

			const response = await harness.request(
				"GET",
				`/v2/session_replays/${sessionId}/events?from_chunk_seq=0&to_chunk_seq=39`,
				{ token: key.secret },
			)
			expect(response.status).toBe(413)
			expect(response.body.error.code).toBe("range_too_large")
			expect(response.body.error.param).toBe("to_chunk_seq")
			// The message survives the public boundary verbatim — it carries no
			// database diagnostics, and it is the only actionable thing here.
			expect(response.body.error.message).toContain("narrower chunk range")
			await harness.dispose()
		})
	})
})

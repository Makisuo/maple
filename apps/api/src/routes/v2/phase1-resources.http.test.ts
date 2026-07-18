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
	InvestigationDocument,
	InvestigationIncidentSubject,
	InvestigationNotFoundError,
	InvestigationsListResponse,
	InvestigationId,
	IsoDateTimeString,
	OrgId,
	UserId,
} from "@maple/domain/http"
import { MapleApiV2, encodePublicId } from "@maple/domain/http/v2"
import { cleanupTestDbs, createTestDb, type TestDb } from "../../lib/test-pglite"
import type { WarehouseQueryServiceShape } from "../../lib/WarehouseQueryService"
import { WarehouseQueryService } from "../../lib/WarehouseQueryService"
import { Env } from "../../lib/Env"
import { AnomalyDetectionService } from "../../services/AnomalyDetectionService"
import { ApiAuthorizationV2Layer } from "../../services/ApiAuthorizationV2Layer"
import { ApiKeysService } from "../../services/ApiKeysService"
import { AuthService } from "../../services/AuthService"
import { DashboardPersistenceService } from "../../services/DashboardPersistenceService"
import { ErrorsService } from "../../services/ErrorsService"
import { InvestigationService } from "../../services/InvestigationService"
import { OrganizationService } from "../../services/OrganizationService"
import { V2SchemaErrorsLive } from "./error-envelope"
import {
	AlertsServiceStubLayer,
	AllV2GroupLayersLive,
	ConfigResourceServiceStubsLayer,
} from "./v2-test-support"

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
const decodeIso = Schema.decodeSync(IsoDateTimeString)

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
	diagnosedAt: decodeIso("2026-07-15T09:12:42.000Z"),
	updatedAt: decodeIso("2026-07-15T09:12:42.000Z"),
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
	new InvestigationDocument({ ...investigationFixture, id: decodeInvId(INV_UUID_2) }),
	new InvestigationDocument({ ...investigationFixture, id: decodeInvId(INV_UUID_3) }),
]

const anomalyFixtures = [
	anomalyFixture,
	new AnomalyIncidentDocument({ ...anomalyFixture, id: decodeAnomId(ANOM_UUID_2) }),
	new AnomalyIncidentDocument({ ...anomalyFixture, id: decodeAnomId(ANOM_UUID_3) }),
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

const die = () => Effect.die(new Error("not exercised in this test harness"))

/** Empty warehouse — enough to exercise the session_replays envelope + 404 paths. */
const warehouseStub: WarehouseQueryServiceShape = {
	query: die,
	sqlQuery: () => Effect.succeed([]),
	compiledQuery: (_tenant, compiled) => compiled.decodeRows([]).pipe(Effect.orDie),
	compiledQueryFirst: () => Effect.succeed(Option.none()),
	ingest: () => Effect.void,
	asExecutor: () => {
		throw new Error("asExecutor is not supported by this test stub")
	},
}

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

const makeHarness = (warehouseService: WarehouseQueryServiceShape = warehouseStub) => {
	const testDb = createTestDb(createdDbs)
	const envLive = Env.layer.pipe(Layer.provide(testConfig()))

	// Functional stubs for the groups under test — provided first so they win
	// over the inert stubs in ConfigResourceServiceStubsLayer.
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
								new InvestigationNotFoundError({ message: `No such investigation: '${id}'` }),
							),
			createInvestigation: () => Effect.succeed(investigationFixture),
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
			setIncidentIssue: () => Effect.succeed({ incident: anomalyFixture, previousIssueId: null }),
			getIncidentTimeseries: () => Effect.succeed(timeseriesFixture),
			getSettings: () => Effect.succeed(settingsFixture),
			updateSettings: () => Effect.succeed(settingsFixture),
		}),
		// Functional ErrorsService for the anomalies issue-link audit path
		// (ensureUserActor + recordAnomalyLinkEvent); everything else is inert.
		Layer.succeed(ErrorsService, {
			listIssues: die,
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
	).pipe(Layer.provideMerge(Layer.mergeAll(envLive, testDb.layer)))

	const routes = HttpApiBuilder.layer(MapleApiV2).pipe(
		Layer.provide(AllV2GroupLayersLive),
		Layer.provide(functionalStubs),
		Layer.provide(V2SchemaErrorsLive),
		Layer.provide(AlertsServiceStubLayer),
		Layer.provide(ConfigResourceServiceStubsLayer),
		Layer.provideMerge(ApiAuthorizationV2Layer),
		Layer.provideMerge(servicesLive),
	)

	const { handler, dispose: disposeHandler } = HttpRouter.toWebHandler(routes, { disableLogger: true })
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

	const bootstrapKey = (scopes?: ReadonlyArray<string>) =>
		runtime.runPromise(
			Effect.gen(function* () {
				const service = yield* ApiKeysService
				return yield* service.create(ORG, USER, { name: "phase1-test", scopes })
			}),
		)

	return {
		request,
		bootstrapKey,
		dispose: async () => {
			await disposeHandler()
			await runtime.dispose()
		},
	}
}

describe("v2 investigations over HTTP", () => {
	it("lists and retrieves with wire shapes", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey()

		const list = await harness.request("GET", "/v2/investigations", { token: key.secret })
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

		const got = await harness.request("GET", `/v2/investigations/${INV_ID}`, { token: key.secret })
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
		expect(response.status).toBe(503)
		expect(response.body.error).toMatchObject({
			type: "api_error",
			code: "investigation_subject_decode_failed",
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
})

describe("v2 anomalies over HTTP", () => {
	it("lists incidents and reads settings with wire shapes", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey()

		const list = await harness.request("GET", "/v2/anomalies/incidents", { token: key.secret })
		expect(list.status).toBe(200)
		expect(list.body.object).toBe("list")
		expect(list.body.data[0].id).toBe(ANOM_ID)
		expect(list.body.data[0].object).toBe("anomaly_incident")
		expect(list.body.data[0].signal_type).toBe("error_rate")
		expect(list.body.data[0].error_issue_id).toBeNull()
		expect(list.body.data[0].baseline_median).toBe(0.01)

		const settings = await harness.request("GET", "/v2/anomalies/settings", { token: key.secret })
		expect(settings.status).toBe(200)
		expect(settings.body.object).toBe("anomaly_settings")
		expect(settings.body.enabled).toBe(true)
		expect(settings.body.muted_signals).toEqual([])
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
			const first = await harness.request("GET", `${path}?limit=1`, { token: key.secret })
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

		const org = await harness.request("GET", "/v2/organization", { token: key.secret })
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
			body: { start_time: "2026-07-15T00:00:00.000Z", end_time: "2026-07-16T00:00:00.000Z" },
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
		expect(forTrace.body).toMatchObject({ object: "list", data: [], has_more: false })

		const invalidCursor = await harness.request("POST", "/v2/session_replays/for_trace", {
			token: key.secret,
			body: { ...window, trace_id: "0123456789abcdef0123456789abcdef", cursor: "garbage" },
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
		}))
		const transcriptWarehouse: WarehouseQueryServiceShape = {
			...warehouseStub,
			compiledQuery: (_tenant, compiled, options) => {
				if (options?.context !== "v2SessionTranscript") {
					return compiled.decodeRows([]).pipe(Effect.orDie)
				}
				const match = /LIMIT\s+(\d+)\s+OFFSET\s+(\d+)/i.exec(compiled.sql)
				const limit = Number(match?.[1] ?? 100)
				const offset = Number(match?.[2] ?? 0)
				return compiled.decodeRows(transcriptRows.slice(offset, offset + limit)).pipe(Effect.orDie)
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
})

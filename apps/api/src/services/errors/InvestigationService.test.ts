import { randomUUID } from "node:crypto"
import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import {
	AiTriageEvidence,
	AiTriageResult,
	InvestigationCreateRequest,
	InvestigationFreeformSubject,
	InvestigationIncidentSubject,
	InvestigationId,
	InvestigationNotFoundError,
	InvestigationRejectedError,
	OrgId,
	SubmitDiagnosisRequest,
} from "@maple/domain/http"
import { ErrorIssueId } from "@maple/domain/primitives"
import { errorIssues, errorIssueEvents, investigations } from "@maple/db"
import { createMaplePgliteClient, type MaplePgClient } from "@maple/db/client"
import { WorkerEnvironment } from "@maple/effect-cloudflare/worker-environment"
import { eq } from "drizzle-orm"
import { Env } from "@/lib/Env"
import { Database } from "@/lib/DatabaseLive"
import { cleanupTestDbs, createTestDb, type TestDb } from "@/lib/test-pglite"
import { InvestigationService } from "./InvestigationService"

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

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
			INTERNAL_SERVICE_TOKEN: "test-internal-token",
		}),
	)

const makeHarness = (workerEnvironment?: Record<string, unknown>) => {
	const testDb = createTestDb(createdDbs)
	let layer = InvestigationService.layer.pipe(
		Layer.provideMerge(testDb.layer),
		Layer.provideMerge(Env.layer),
		Layer.provide(testConfig()),
	)
	if (workerEnvironment !== undefined) {
		layer = layer.pipe(Layer.provideMerge(Layer.succeed(WorkerEnvironment, workerEnvironment)))
	}
	return { testDb, layer }
}

const makeLayer = () => makeHarness().layer

const ORG = Schema.decodeUnknownSync(OrgId)("org_investigation_test")
const asInvestigationId = Schema.decodeUnknownSync(InvestigationId)
const asIssueId = Schema.decodeUnknownSync(ErrorIssueId)

const freeformRequest = (title: string) =>
	new InvestigationCreateRequest({
		subject: new InvestigationFreeformSubject({
			type: "freeform",
			title,
			prompt: `Investigate ${title}`,
			contextRefs: [],
		}),
	})

const incidentRequest = (incidentId: string) =>
	new InvestigationCreateRequest({
		subject: new InvestigationIncidentSubject({
			type: "incident",
			incidentKind: "error",
			incidentId,
		}),
	})

const sampleReport = () =>
	new AiTriageResult({
		summary: "Checkout latency doubled after the 14:00 deploy.",
		suspectedCause: "Regression in the payments client connection pool",
		severityAssessment: "high",
		affectedScope: "checkout-api, p95 across all regions",
		evidence: [
			new AiTriageEvidence({
				traceIds: ["abc123def456"],
				logPatterns: ["pool exhausted"],
				relatedServices: ["payments"],
				note: "Pool saturation in the failing traces",
			}),
		],
		suggestedActions: ["Roll back the 14:00 deploy", "Raise the pool size"],
		confidence: "high",
	})

describe("InvestigationService", () => {
	it.effect("creates a free-form investigation in the investigating state", () =>
		Effect.gen(function* () {
			const service = yield* InvestigationService
			const doc = yield* service.createInvestigation(ORG, null, freeformRequest("checkout latency"))
			assert.strictEqual(doc.status, "investigating")
			assert.strictEqual(doc.subject.type, "freeform")
			assert.strictEqual(doc.report, null)
			assert.strictEqual(doc.seededBy, "system")
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("dedups incident investigations to one row per incident", () =>
		Effect.gen(function* () {
			const service = yield* InvestigationService
			const first = yield* service.createInvestigation(ORG, null, incidentRequest("err_incident_1"))
			const second = yield* service.createInvestigation(ORG, null, incidentRequest("err_incident_1"))
			assert.strictEqual(first.id, second.id)

			const list = yield* service.listInvestigations(ORG, { incidentKind: "error" })
			assert.strictEqual(list.investigations.length, 1)
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("submit_diagnosis persists the report and is idempotent", () =>
		Effect.gen(function* () {
			const service = yield* InvestigationService
			const created = yield* service.createInvestigation(ORG, null, freeformRequest("error spike"))

			const diagnosed = yield* service.submitDiagnosis(
				ORG,
				created.id,
				new SubmitDiagnosisRequest({ report: sampleReport(), model: "test-model" }),
			)
			assert.strictEqual(diagnosed.status, "diagnosed")
			assert.strictEqual(diagnosed.severity, "high")
			assert.strictEqual(diagnosed.confidence, "high")
			assert.strictEqual(diagnosed.report?.suspectedCause, sampleReport().suspectedCause)
			assert.strictEqual(diagnosed.model, "test-model")

			// Re-diagnosis updates in place without error (idempotent on the id).
			const rediagnosed = yield* service.submitDiagnosis(
				ORG,
				created.id,
				new SubmitDiagnosisRequest({ report: sampleReport() }),
			)
			assert.strictEqual(rediagnosed.id, created.id)
			assert.strictEqual(rediagnosed.status, "diagnosed")
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("getInvestigation fails with InvestigationNotFoundError for an unknown id", () =>
		Effect.gen(function* () {
			const service = yield* InvestigationService
			const error = yield* Effect.flip(
				service.getInvestigation(ORG, asInvestigationId("00000000-0000-4000-8000-000000000000")),
			)
			assert.instanceOf(error, InvestigationNotFoundError)
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("updateStatus transitions an investigation and persists the new status", () =>
		Effect.gen(function* () {
			const service = yield* InvestigationService
			const created = yield* service.createInvestigation(ORG, null, freeformRequest("status flow"))
			assert.strictEqual(created.status, "investigating")

			const updated = yield* service.updateStatus(ORG, created.id, "resolved")
			assert.strictEqual(updated.status, "resolved")

			// The change is durable, not just reflected in the return value.
			const fetched = yield* service.getInvestigation(ORG, created.id)
			assert.strictEqual(fetched.status, "resolved")
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("updateStatus fails with InvestigationNotFoundError for an unknown id", () =>
		Effect.gen(function* () {
			const service = yield* InvestigationService
			const error = yield* Effect.flip(
				service.updateStatus(
					ORG,
					asInvestigationId("00000000-0000-4000-8000-000000000001"),
					"resolved",
				),
			)
			assert.instanceOf(error, InvestigationNotFoundError)
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("starts an autonomous turn with the configured token and preserved context", () => {
		const requests: Request[] = []
		const harness = makeHarness({
			CHAT_FLUE: {
				fetch: async (request: Request) => {
					requests.push(request)
					return new Response(null, { status: 202 })
				},
			},
		})
		return Effect.gen(function* () {
			const service = yield* InvestigationService
			const started = yield* service.createAndStartInvestigation(
				ORG,
				null,
				incidentRequest("err_autonomous_start"),
				{ automatic: false },
			)
			assert.strictEqual(started.status, "investigating")
			assert.lengthOf(requests, 1)
			assert.strictEqual(requests[0]?.method, "POST")
			assert.strictEqual(
				requests[0]?.headers.get("authorization"),
				"Bearer maple_svc_test-internal-token",
			)
			const body = (yield* Effect.promise(() => requests[0]!.json())) as { message: string }
			assert.include(body.message, '"incidentId":"err_autonomous_start"')
			assert.include(body.message, '"snapshot"')

			const database = yield* Database
			const databaseRows = yield* database.execute((db) =>
				db.select().from(investigations).where(eq(investigations.id, started.id)),
			)
			assert.strictEqual(databaseRows[0]?.autonomousTurns, 1)
		}).pipe(Effect.provide(harness.layer))
	})

	it.effect("surfaces terminal agent rejection separately from retryable unavailability", () => {
		const harness = makeHarness({
			CHAT_FLUE: {
				fetch: async () => new Response(null, { status: 401 }),
			},
		})
		return Effect.gen(function* () {
			const service = yield* InvestigationService
			const error = yield* Effect.flip(
				service.createAndStartInvestigation(ORG, null, incidentRequest("err_rejected_start"), {
					automatic: false,
				}),
			)
			assert.instanceOf(error, InvestigationRejectedError)
			assert.strictEqual(error.status, 401)
		}).pipe(Effect.provide(harness.layer))
	})

	it.effect(
		"submit_diagnosis writes the issue-linked ai_triage event exactly once across re-diagnosis",
		() => {
			const harness = makeHarness()
			const raw = createMaplePgliteClient(harness.testDb.pglite) as unknown as MaplePgClient
			const issueId = asIssueId(randomUUID())
			return Effect.gen(function* () {
				const service = yield* InvestigationService
				// Forcing the service (above) builds the DB layer + runs migrations on the
				// shared PGlite, so the raw client can now seed the linked error issue.
				const now = new Date()
				yield* Effect.promise(() =>
					raw.insert(errorIssues).values({
						id: issueId,
						orgId: ORG,
						fingerprintHash: "98765432109876543210",
						serviceName: "checkout-api",
						exceptionType: "TimeoutError",
						exceptionMessage: "upstream timed out",
						topFrame: "",
						firstSeenAt: now,
						lastSeenAt: now,
						createdAt: now,
						updatedAt: now,
					}),
				)

				const created = yield* service.createInvestigation(
					ORG,
					null,
					new InvestigationCreateRequest({
						subject: new InvestigationIncidentSubject({
							type: "incident",
							incidentKind: "error",
							incidentId: "err_issue_link_1",
							issueId,
						}),
					}),
				)

				// Two diagnosis writes (retry / re-diagnosis): the deterministic event id +
				// onConflictDoNothing must collapse them to a single timeline event.
				yield* service.submitDiagnosis(
					ORG,
					created.id,
					new SubmitDiagnosisRequest({ report: sampleReport() }),
				)
				yield* service.submitDiagnosis(
					ORG,
					created.id,
					new SubmitDiagnosisRequest({ report: sampleReport() }),
				)

				const events = yield* Effect.promise(() =>
					raw.select().from(errorIssueEvents).where(eq(errorIssueEvents.issueId, issueId)),
				)
				const aiTriageEvents = events.filter((e) => e.type === "ai_triage")
				assert.strictEqual(aiTriageEvents.length, 1)
			}).pipe(Effect.provide(harness.layer))
		},
	)
})

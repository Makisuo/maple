import { randomUUID } from "node:crypto"
import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Exit, Layer, Schema } from "effect"
import {
	AiTriageEvidence,
	AiTriageResult,
	InvestigationCreateRequest,
	InvestigationFreeformSubject,
	InvestigationIncidentSubject,
	InvestigationId,
	InvestigationNotFoundError,
	InvestigationSubjectSnapshot,
	InvestigationUnavailableError,
	OrgId,
	SubmitDiagnosisRequest,
} from "@maple/domain/http"
import { ErrorIssueId } from "@maple/domain/primitives"
import {
	aiTriageSettings,
	errorIssues,
	errorIssueEvents,
	investigationLensRuns,
	investigations,
} from "@maple/db"
import { createMaplePgliteClient, type MaplePgClient } from "@maple/db/client"
import { WorkerEnvironment } from "@maple/effect-cloudflare/worker-environment"
import { eq } from "drizzle-orm"
import { Env } from "@/platform/Env"
import { Database } from "@/platform/DatabaseLive"
import { cleanupTestDbs, createTestDb, type TestDb } from "@/platform/test-pglite"
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

const criticalIncidentRequest = (incidentId: string) =>
	new InvestigationCreateRequest({
		subject: new InvestigationIncidentSubject({
			type: "incident",
			incidentKind: "error",
			incidentId,
		}),
		snapshot: new InvestigationSubjectSnapshot({
			title: "Checkout timeouts",
			scope: "checkout-api",
			status: "open",
			severity: "critical",
			facts: [],
			references: [],
			incidentStartedAt: null,
			incidentEndedAt: null,
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

	/**
	 * Stub `CHAT_SESSION` namespace. The autonomous turn now claims the turn on the ChatSession
	 * Durable Object in process instead of POSTing back to chat-flue over a service binding, so the
	 * observable contract is one `beginTurn` call rather than an HTTP request. The real object
	 * also runs the turn inside itself; nothing here does, which is the point.
	 */
	const chatSessionHarness = (options?: { readonly busy?: boolean }) => {
		const beginTurns: Array<{ messageId: string; text: string }> = []
		const namespace = {
			idFromName: (name: string) => name,
			get: () => ({
				history: async () => [],
				beginTurn: async (input: { messageId: string; text: string }) => {
					beginTurns.push({ messageId: input.messageId, text: input.text })
					return options?.busy === true ? undefined : { cursor: 0, messageId: input.messageId }
				},
				append: async () => 1,
				endTurn: async () => undefined,
			}),
		}
		return { beginTurns, env: { CHAT_SESSION: namespace } }
	}

	/**
	 * Fan-out routing. The gate lives in `fanout-policy` and is tested there as a
	 * table; what these assert is that the service actually *branches* on it —
	 * that a fan-out start reaches the workflow and never the chat session, and a
	 * single-pass start the reverse.
	 */
	const fanoutWorkflowHarness = (options?: { readonly failing?: boolean }) => {
		const creates: Array<{ id: string; params: Record<string, unknown> }> = []
		return {
			creates,
			binding: {
				create: async (input: { id: string; params: Record<string, unknown> }) => {
					if (options?.failing === true) throw new Error("instance already exists")
					creates.push(input)
					return { id: input.id }
				},
			},
		}
	}

	const enableFanout = (harness: ReturnType<typeof makeHarness>) =>
		Effect.gen(function* () {
			const database = yield* Database
			yield* database.execute((db) =>
				db.insert(aiTriageSettings).values({
					orgId: ORG,
					enabled: true,
					fanoutEnabled: true,
					updatedAt: new Date(),
				}),
			)
		}).pipe(Effect.provide(harness.layer))

	it.effect("routes a manual critical incident to the fan-out workflow", () => {
		const chat = chatSessionHarness()
		const workflow = fanoutWorkflowHarness()
		const harness = makeHarness({
			...chat.env,
			INVESTIGATION_FANOUT_WORKFLOW: workflow.binding,
		})
		return Effect.gen(function* () {
			const database = yield* Database
			yield* database.execute((db) =>
				db.insert(aiTriageSettings).values({
					orgId: ORG,
					enabled: true,
					fanoutEnabled: true,
					updatedAt: new Date(),
				}),
			)
			const started = yield* InvestigationService.pipe(
				Effect.flatMap((service) =>
					service.createAndStartInvestigation(ORG, null, criticalIncidentRequest("err_fanout"), {
						automatic: false,
					}),
				),
			)
			assert.strictEqual(started.status, "investigating")
			// The workflow ran; the single-pass chat turn did not.
			assert.lengthOf(workflow.creates, 1)
			assert.lengthOf(chat.beginTurns, 0)
			assert.strictEqual(workflow.creates[0]!.params.investigationId, started.id)
			assert.lengthOf(workflow.creates[0]!.params.lensIds as ReadonlyArray<string>, 5)

			const rows = yield* database.execute((db) =>
				db.select().from(investigations).where(eq(investigations.id, started.id)),
			)
			assert.strictEqual(rows[0]?.fanoutState, "queued")
			assert.strictEqual(rows[0]?.fanoutSize, 5)
			// Quota counts passes, not runs: five lenses plus the validator.
			assert.strictEqual(rows[0]?.autonomousTurns, 6)
		}).pipe(Effect.provide(harness.layer))
	})

	it.effect("keeps the single pass when the org has not enabled fan-out", () => {
		const chat = chatSessionHarness()
		const workflow = fanoutWorkflowHarness()
		const harness = makeHarness({
			...chat.env,
			INVESTIGATION_FANOUT_WORKFLOW: workflow.binding,
		})
		return Effect.gen(function* () {
			const started = yield* InvestigationService.pipe(
				Effect.flatMap((service) =>
					service.createAndStartInvestigation(ORG, null, criticalIncidentRequest("err_fanout"), {
						automatic: false,
					}),
				),
			)
			assert.strictEqual(started.status, "investigating")
			assert.lengthOf(workflow.creates, 0)
			assert.lengthOf(chat.beginTurns, 1)

			const database = yield* Database
			const rows = yield* database.execute((db) =>
				db.select().from(investigations).where(eq(investigations.id, started.id)),
			)
			assert.strictEqual(rows[0]?.fanoutState, "none")
			assert.strictEqual(rows[0]?.autonomousTurns, 1)
		}).pipe(Effect.provide(harness.layer))
	})

	it.effect("marks the row agent_unavailable when the fan-out binding is missing", () => {
		const chat = chatSessionHarness()
		const harness = makeHarness(chat.env)
		return Effect.gen(function* () {
			const database = yield* Database
			yield* database.execute((db) =>
				db.insert(aiTriageSettings).values({
					orgId: ORG,
					enabled: true,
					fanoutEnabled: true,
					updatedAt: new Date(),
				}),
			)
			const exit = yield* Effect.exit(
				InvestigationService.pipe(
					Effect.flatMap((service) =>
						service.createAndStartInvestigation(
							ORG,
							null,
							criticalIncidentRequest("err_fanout"),
							{
								automatic: false,
							},
						),
					),
				),
			)
			assert.isTrue(Exit.isFailure(exit))

			const rows = yield* database.execute((db) =>
				db.select().from(investigations).where(eq(investigations.orgId, ORG)),
			)
			assert.strictEqual(rows[0]?.status, "failed")
			assert.include(rows[0]?.error ?? "", "agent_unavailable")
		}).pipe(Effect.provide(harness.layer))
	})

	it.effect("hides the previous attempt's lanes and starts a fresh instance on restart", () => {
		const chat = chatSessionHarness()
		const workflow = fanoutWorkflowHarness()
		const harness = makeHarness({
			...chat.env,
			INVESTIGATION_FANOUT_WORKFLOW: workflow.binding,
		})
		return Effect.gen(function* () {
			const database = yield* Database
			yield* database.execute((db) =>
				db.insert(aiTriageSettings).values({
					orgId: ORG,
					enabled: true,
					fanoutEnabled: true,
					updatedAt: new Date(),
				}),
			)
			const service = yield* InvestigationService
			const started = yield* InvestigationService.pipe(
				Effect.flatMap((service) =>
					service.createAndStartInvestigation(ORG, null, criticalIncidentRequest("err_fanout"), {
						automatic: false,
					}),
				),
			)
			// Seed a lane from the first attempt.
			yield* database.execute((db) =>
				db.insert(investigationLensRuns).values({
					id: "lane-1",
					orgId: ORG,
					investigationId: started.id,
					lensId: "deploy_correlation",
					ordinal: 0,
					status: "reported",
					verdict: "promoted",
					claim: "stale claim from the first attempt",
					createdAt: new Date(),
					updatedAt: new Date(),
				}),
			)

			yield* service.restartInvestigation(ORG, started.id)

			// The stale lane still exists on attempt 0, but the document no longer
			// carries it: reads are scoped to the row's current attempt, so a
			// straggler from the terminated instance cannot appear beside the retry.
			const restarted = yield* service.getInvestigation(ORG, started.id)
			assert.lengthOf(restarted.lensRuns, 0)

			const lanes = yield* database.execute((db) =>
				db
					.select()
					.from(investigationLensRuns)
					.where(eq(investigationLensRuns.investigationId, started.id)),
			)
			assert.lengthOf(lanes, 1)
			assert.strictEqual(lanes[0]?.attempt, 0)
			// A restart needs a distinct workflow instance id or Cloudflare rejects it.
			assert.lengthOf(workflow.creates, 2)
			assert.notStrictEqual(workflow.creates[0]!.id, workflow.creates[1]!.id)
		}).pipe(Effect.provide(harness.layer))
	})

	it.effect("starts an autonomous turn carrying the preserved context", () => {
		const chat = chatSessionHarness()
		const harness = makeHarness(chat.env)
		return Effect.gen(function* () {
			const service = yield* InvestigationService
			const started = yield* service.createAndStartInvestigation(
				ORG,
				null,
				incidentRequest("err_autonomous_start"),
				{ automatic: false },
			)
			assert.strictEqual(started.status, "investigating")
			assert.lengthOf(chat.beginTurns, 1)
			assert.include(chat.beginTurns[0]!.text, '"incidentId":"err_autonomous_start"')
			assert.include(chat.beginTurns[0]!.text, '"snapshot"')

			const database = yield* Database
			const databaseRows = yield* database.execute((db) =>
				db.select().from(investigations).where(eq(investigations.id, started.id)),
			)
			assert.strictEqual(databaseRows[0]?.autonomousTurns, 1)
		}).pipe(Effect.provide(harness.layer))
	})

	it.effect("fails retryably when the chat session binding is missing", () => {
		const harness = makeHarness({})
		return Effect.gen(function* () {
			const service = yield* InvestigationService
			const error = yield* Effect.flip(
				service.createAndStartInvestigation(ORG, null, incidentRequest("err_no_binding"), {
					automatic: false,
				}),
			)
			assert.instanceOf(error, InvestigationUnavailableError)
			assert.strictEqual(error.reason, "agent_unavailable")
			assert.isTrue(error.retryable)
		}).pipe(Effect.provide(harness.layer))
	})

	it.effect("fails retryably when a turn is already in flight for the session", () => {
		const chat = chatSessionHarness({ busy: true })
		const harness = makeHarness(chat.env)
		return Effect.gen(function* () {
			const service = yield* InvestigationService
			const error = yield* Effect.flip(
				service.createAndStartInvestigation(ORG, null, incidentRequest("err_busy"), {
					automatic: false,
				}),
			)
			assert.instanceOf(error, InvestigationUnavailableError)
			assert.isTrue(error.retryable)
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

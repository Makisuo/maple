/**
 * Headless AI triage workflow logic (heavy import graph lives here, NOT in the
 * thin class shell — see the dynamic import in `AiTriageWorkflow.ts`).
 *
 * Investigates a freshly opened incident (error or anomaly) and persists a
 * structured triage result onto `ai_triage_runs` (+ the error-issue timeline).
 *
 * The LLM investigation itself runs on the Flue `triage` workflow (Cloudflare
 * Workers AI + the read-only Maple MCP tools), reached over the `CHAT_FLUE`
 * service binding. This workflow stays the durable orchestrator: it owns the
 * incident lifecycle (gate/claim, D1 persistence, issue severity + timeline,
 * Autumn token tracking) and delegates only the "brain" to Flue.
 *
 * Step layout:
 *   1. gate-and-claim — replay guard, chat-flue binding check
 *   2. run-agent      — invoke the Flue triage workflow (one durable I/O-bound
 *                       step) and map its structured result
 *   3. persist        — run row + issue timeline + usage tracking
 */
import { createHash } from "node:crypto"
import { createFlueClient } from "@flue/sdk"
import * as MapleCloudflareSDK from "@maple-dev/effect-sdk/cloudflare"
import { aiTriageRuns, anomalyIncidents, errorIssueEvents } from "@maple/db"
import { createMaplePgClient, type MaplePgClient } from "@maple/db/client"
import { ANTICIPATED_ERROR_TAGS } from "@maple/domain/anticipated-errors"
import { AiTriageResult } from "@maple/domain/http"
import {
	AiTriageRunId,
	AnomalyIncidentId,
	ErrorIssueEventId,
	ErrorIssueId,
	OrgId,
} from "@maple/domain/primitives"
import { and, eq } from "drizzle-orm"
import { Cause, Data, Effect, Exit, Option, Schema } from "effect"
import { trackTokenUsage } from "../lib/autumn-tracker"
import { applyTriageSeverity } from "../lib/issue-severity"
import type { WorkflowEventLike, WorkflowStepLike } from "./ClickHouseSchemaApplyWorkflow.run"

/** Minimal shape of the `CHAT_FLUE` service binding (a Cloudflare `Fetcher`). */
interface ChatFlueBinding {
	readonly fetch: typeof fetch
}

const isChatFlueBinding = (value: unknown): value is ChatFlueBinding =>
	typeof value === "object" && value !== null && typeof (value as { fetch?: unknown }).fetch === "function"

export interface AiTriageWorkflowEnv extends Record<string, unknown> {
	readonly MAPLE_DB: unknown
	readonly INTERNAL_SERVICE_TOKEN?: string
	/** Service binding to the chat-flue worker that hosts the Flue `triage` workflow. */
	readonly CHAT_FLUE?: ChatFlueBinding
}

/** Structured result the Flue `triage` workflow's `run()` returns. */
interface FlueTriageResult {
	readonly result: unknown
	readonly model: { readonly provider: string; readonly id: string }
	readonly usage: { readonly input: number; readonly output: number }
}

interface InvokeTriageInput {
	readonly env: AiTriageWorkflowEnv
	readonly orgId: string
	readonly incidentKind: "error" | "anomaly" | "alert"
	readonly incidentId: string
	readonly context: Record<string, unknown>
}

/**
 * Run the Flue `triage` workflow to completion over the `CHAT_FLUE` service
 * binding and return its terminal result. The binding routes by name (not host)
 * so `baseUrl` is a placeholder; auth is the internal-service token the
 * chat-flue `/workflows/*` guard expects (`Bearer maple_svc_<token>`).
 */
const invokeTriageWorkflow = async ({
	env,
	orgId,
	incidentKind,
	incidentId,
	context,
}: InvokeTriageInput): Promise<FlueTriageResult> => {
	const binding = env.CHAT_FLUE
	if (!isChatFlueBinding(binding)) throw new Error("chat_flue_unavailable")

	const client = createFlueClient({
		baseUrl: "https://chat-flue.internal",
		fetch: binding.fetch.bind(binding),
		token: `maple_svc_${env.INTERNAL_SERVICE_TOKEN ?? ""}`,
	})

	const response = await client.workflows.invoke("triage", {
		payload: { orgId, incidentKind, incidentId, context },
		wait: "result",
	})

	const inner = response.result as
		| {
				result?: unknown
				model?: { provider: string; id: string }
				usage?: { input?: number; output?: number }
		  }
		| null
		| undefined
	if (!inner || inner.result === undefined) throw new Error("flue_triage_no_result")

	return {
		result: inner.result,
		model: inner.model ?? { provider: "cloudflare", id: "unknown" },
		usage: { input: inner.usage?.input ?? 0, output: inner.usage?.output ?? 0 },
	}
}

export interface AiTriageWorkflowPayload {
	readonly orgId: string
	readonly incidentKind: "error" | "anomaly" | "alert"
	readonly incidentId: string
	readonly issueId?: string
	readonly runId: string
}

export interface AiTriageWorkflowResult {
	readonly status: "completed" | "failed" | "skipped"
}

const decodeOrgId = Schema.decodeUnknownSync(OrgId)
const decodeRunId = Schema.decodeUnknownSync(AiTriageRunId)
const decodeIssueId = Schema.decodeUnknownSync(ErrorIssueId)
const decodeEventId = Schema.decodeUnknownSync(ErrorIssueEventId)
const decodeAnomalyIncidentId = Schema.decodeUnknownSync(AnomalyIncidentId)
/** Validate the Flue triage result against the canonical domain schema before persisting. */
const decodeTriageResult = Schema.decodeUnknownSync(AiTriageResult)

/** Lenient decode for the contextJson jsonb column; failures fall back to {}. */
const decodeContextJson = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown))
/**
 * One decode from the persisted resultJson string straight to AiTriageResult —
 * composing `fromJsonString` means a malformed string and a shape mismatch
 * both fail through the schema error channel instead of a bare JSON.parse
 * throw in front of the decode.
 */
const decodeTriageResultJson = Schema.decodeUnknownSync(Schema.fromJsonString(AiTriageResult))

/**
 * Typed wrapper for the LLM call's rejection so the Effect error channel is
 * not `unknown`. Unwrapped (`.cause`) at the squash-and-rethrow boundary so
 * the value thrown to the workflow runtime stays the original error.
 */
class TriageGenerateError extends Data.TaggedError("TriageGenerateError")<{
	readonly cause: unknown
}> {}

/**
 * UUIDv5-style id derived from the runId, so the timeline-event insert in the
 * retryable persist step is idempotent: a retry regenerates the SAME id and the
 * primary key (+ onConflictDoNothing) absorbs the duplicate.
 */
const deterministicEventId = (runId: string): string => {
	const hex = createHash("sha256").update(`ai-triage-event:${runId}`).digest("hex")
	return [
		hex.slice(0, 8),
		hex.slice(8, 12),
		`5${hex.slice(13, 16)}`,
		`${((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}`,
		hex.slice(20, 32),
	].join("-")
}

/**
 * Tracer for the triage LLM loop's `gen_ai.*` span. The workflow entrypoint
 * has no ambient tracer (the worker's telemetry layer lives in the HTTP
 * handler's runtime), so this module owns its own SDK instance and flushes it
 * explicitly after the agent step. Module scope is safe here — this file is
 * only ever dynamically imported inside `run()`, off the startup-CPU path.
 */
const triageTelemetry = MapleCloudflareSDK.make({
	serviceName: "maple-api",
	serviceNamespace: "backend",
	repositoryUrl: "https://github.com/Makisuo/maple",
	anticipatedErrorTags: [...ANTICIPATED_ERROR_TAGS],
})

const GATE_STEP = { retries: { limit: 3, delay: "2 seconds", backoff: "exponential" } }
// One retry at most — a retried step re-runs the whole Flue investigation.
const AGENT_STEP = {
	retries: { limit: 1, delay: "10 seconds" },
	timeout: "10 minutes",
}
const PERSIST_STEP = { retries: { limit: 5, delay: "2 seconds", backoff: "exponential" } }

interface AgentStepResult {
	readonly resultJson: string
	readonly model: string
	readonly inputTokens: number
	readonly outputTokens: number
}

/**
 * Narrow the worker env's `MAPLE_DB` Hyperdrive binding to its connection
 * string. (Local copy of the schema-apply workflow's helper so this dynamic
 * chunk doesn't pull in the ClickHouse migration graph.)
 */
const resolveMapleDbConnectionString = (binding: unknown): string => {
	if (
		typeof binding === "object" &&
		binding !== null &&
		typeof (binding as { connectionString?: unknown }).connectionString === "string"
	) {
		return (binding as { connectionString: string }).connectionString
	}
	throw new Error("MAPLE_DB is not a Hyperdrive binding (missing connectionString)")
}

export interface AiTriageRunDeps {
	/** Test seam: swap the database client (e.g. a PGlite-backed drizzle). */
	readonly db?: MaplePgClient
	/**
	 * Test seam: stub the Flue triage invocation so the test asserts the persist
	 * path without crossing the `CHAT_FLUE` service binding. Production invokes
	 * the deployed Flue `triage` workflow.
	 */
	readonly invokeTriage?: typeof invokeTriageWorkflow
	/** Test seam: fixed clock for timestamp assertions. Production uses Date.now. */
	readonly now?: () => number
}

export async function runAiTriage(
	env: AiTriageWorkflowEnv,
	event: WorkflowEventLike<AiTriageWorkflowPayload>,
	step: WorkflowStepLike,
	deps: AiTriageRunDeps = {},
): Promise<AiTriageWorkflowResult> {
	// Injected test clients are owned by the caller; the workflow only ends the
	// postgres.js connection it dialed itself.
	const connection: { readonly db: MaplePgClient; readonly end?: () => Promise<void> } =
		deps.db !== undefined
			? { db: deps.db }
			: createMaplePgClient(resolveMapleDbConnectionString(env.MAPLE_DB), { maxConnections: 1 })
	try {
		return await runAiTriageWithDb(connection.db, env, event, step, deps)
	} finally {
		await connection.end?.().catch(() => undefined)
	}
}

async function runAiTriageWithDb(
	db: MaplePgClient,
	env: AiTriageWorkflowEnv,
	event: WorkflowEventLike<AiTriageWorkflowPayload>,
	step: WorkflowStepLike,
	deps: AiTriageRunDeps,
): Promise<AiTriageWorkflowResult> {
	const { orgId, incidentKind, incidentId, issueId } = event.payload
	const runId = decodeRunId(event.payload.runId)
	const invokeTriage = deps.invokeTriage ?? invokeTriageWorkflow
	const clock = deps.now ?? Date.now

	/**
	 * Failure-path structured log, routed through the module's OTLP telemetry
	 * (console.error alone never reaches the log pipeline). Defensive: a
	 * telemetry problem must never mask the original failure path, so anything
	 * thrown here is caught and demoted to console.error.
	 */
	const logFailure = async (message: string, fields: Record<string, unknown>): Promise<void> => {
		try {
			await Effect.runPromise(
				Effect.logError(message, fields).pipe(Effect.provide(triageTelemetry.layer)),
			)
			await triageTelemetry.flush(env)
		} catch (cause) {
			console.error("ai-triage: failed to emit structured failure log", { error: String(cause) })
		}
	}

	const markFailed = async (error: string) => {
		const now = clock()
		try {
			await db
				.update(aiTriageRuns)
				.set({ status: "failed", error, completedAt: new Date(now), updatedAt: new Date(now) })
				.where(and(eq(aiTriageRuns.orgId, decodeOrgId(orgId)), eq(aiTriageRuns.id, runId)))
			if (incidentKind === "anomaly") {
				await db
					.update(anomalyIncidents)
					.set({ triageStatus: "skipped", updatedAt: new Date(now) })
					.where(
						and(
							eq(anomalyIncidents.orgId, decodeOrgId(orgId)),
							eq(anomalyIncidents.id, decodeAnomalyIncidentId(incidentId)),
						),
					)
			}
		} catch (cause) {
			// If this write is lost the row stays queued/running until the enqueue
			// path reclaims it as stranded (STALE_RUN_RECLAIM_MS) — surface why in
			// the Workers logs instead of swallowing it.
			console.error("ai-triage: failed to mark run failed", {
				runId,
				orgId,
				error: String(cause),
			})
			await logFailure("ai-triage: failed to mark run failed", {
				runId,
				orgId,
				error: String(cause),
			})
		}
	}

	const gate = await step.do("gate-and-claim", GATE_STEP, async () => {
		const rows = await db.select().from(aiTriageRuns).where(eq(aiTriageRuns.id, runId)).limit(1)
		const run = rows[0]
		// Replay guard: a re-delivered event for a run that already progressed is
		// a no-op (statuses other than queued mean another execution owns it).
		if (!run || run.status !== "queued") {
			return { proceed: false as const, contextJson: {} }
		}

		// The investigation runs on chat-flue over the CHAT_FLUE service binding;
		// without it (e.g. a worker deployed before the binding existed) the run
		// can't proceed — fail it explicitly rather than hang.
		if (!isChatFlueBinding(env.CHAT_FLUE)) {
			return { proceed: false as const, failure: "chat_flue_unavailable", contextJson: run.contextJson }
		}

		const now = clock()
		await db
			.update(aiTriageRuns)
			.set({ status: "running", startedAt: new Date(now), updatedAt: new Date(now) })
			.where(eq(aiTriageRuns.id, runId))

		return { proceed: true as const, contextJson: run.contextJson }
	})

	if (!gate.proceed) {
		if ("failure" in gate && gate.failure) {
			console.error("ai-triage: run failed before agent start", {
				runId,
				orgId,
				reason: gate.failure,
			})
			await logFailure("ai-triage: run failed before agent start", {
				runId,
				orgId,
				reason: gate.failure,
			})
			await markFailed(gate.failure)
			return { status: "failed" }
		}
		return { status: "skipped" }
	}

	let agentResult: AgentStepResult
	try {
		agentResult = await step.do("run-agent", AGENT_STEP, async () => {
			const context: Record<string, unknown> = Option.getOrElse(
				decodeContextJson(gate.contextJson),
				() => ({}),
			)

			// Delegate the investigation to the Flue `triage` workflow. The Flue side
			// emits its own gen_ai.* spans (service `maple-chat-flue`); this span
			// records the delegation + token counts on the api side for correlation.
			const generateExit = await Effect.runPromiseExit(
				Effect.tryPromise({
					try: () => invokeTriage({ env, orgId, incidentKind, incidentId, context }),
					catch: (error) => new TriageGenerateError({ cause: error }),
				}).pipe(
					Effect.tap((r) =>
						Effect.annotateCurrentSpan({
							"gen_ai.usage.input_tokens": r.usage.input,
							"gen_ai.usage.output_tokens": r.usage.output,
							"gen_ai.request.model": r.model.id,
						}),
					),
					Effect.withSpan("ai_triage.generate", {
						kind: "client",
						attributes: {
							"gen_ai.operation.name": "chat",
							"gen_ai.provider.name": "cloudflare.workers_ai",
							orgId,
						},
					}),
					Effect.provide(triageTelemetry.layer),
				),
			)
			await triageTelemetry.flush(env)
			// Re-throw the original error so the step's failure handling (and the
			// message persisted by markFailed) is unchanged by the span wrapper:
			// unwrap the TriageGenerateError envelope back to its cause; defects
			// are squashed and thrown as before.
			if (Exit.isFailure(generateExit)) {
				const squashed = Cause.squash(generateExit.cause)
				throw squashed instanceof TriageGenerateError ? squashed.cause : squashed
			}
			const flue = generateExit.value
			// Validate the Flue result against the canonical domain schema before it
			// reaches the DB (Flue already validated its Valibot mirror, but this is
			// the source of truth for persistence).
			const decoded = decodeTriageResult(flue.result)

			return {
				resultJson: JSON.stringify(decoded),
				model: flue.model.id,
				inputTokens: flue.usage.input,
				outputTokens: flue.usage.output,
			}
		})
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		console.error("ai-triage: agent run failed", { runId, orgId, error: message })
		await logFailure("ai-triage: agent run failed", { runId, orgId, error: message })
		await markFailed(message.slice(0, 2000))
		return { status: "failed" }
	}

	await step.do("persist", PERSIST_STEP, async () => {
		const now = clock()
		await db
			.update(aiTriageRuns)
			.set({
				status: "completed",
				// The agent step's durable output stays a JSON string (1 MiB step
				// cap bookkeeping); parse at the jsonb write boundary.
				resultJson: JSON.parse(agentResult.resultJson),
				model: agentResult.model,
				inputTokens: agentResult.inputTokens,
				outputTokens: agentResult.outputTokens,
				error: null,
				completedAt: new Date(now),
				updatedAt: new Date(now),
			})
			.where(and(eq(aiTriageRuns.orgId, decodeOrgId(orgId)), eq(aiTriageRuns.id, runId)))

		if (issueId) {
			// Any linked issue (error fingerprint, alert-backed, or anomaly-linked)
			// gets the triage outcome applied: severity (respecting manual
			// override) + timeline events + escalation outbox. All writes are
			// idempotent via runId-derived deterministic ids, so a retried persist
			// step cannot duplicate them.
			const result = decodeTriageResultJson(agentResult.resultJson)
			const applied = await applyTriageSeverity(db, {
				orgId: decodeOrgId(orgId),
				issueId: decodeIssueId(issueId),
				runId,
				severity: result.severityAssessment,
				confidence: result.confidence,
				timestamp: now,
				result,
			})
			await db
				.insert(errorIssueEvents)
				.values({
					id: decodeEventId(deterministicEventId(runId)),
					orgId: decodeOrgId(orgId),
					issueId: decodeIssueId(issueId),
					actorId: applied.actorId,
					type: "ai_triage",
					payloadJson: {
						runId,
						summary: result.summary,
						severityAssessment: result.severityAssessment,
						confidence: result.confidence,
						applied: applied.applied,
					},
					createdAt: new Date(now),
				})
				.onConflictDoNothing()
		}

		if (incidentKind === "anomaly") {
			await db
				.update(anomalyIncidents)
				.set({ triageStatus: "completed", updatedAt: new Date(now) })
				.where(
					and(
						eq(anomalyIncidents.orgId, decodeOrgId(orgId)),
						eq(anomalyIncidents.id, decodeAnomalyIncidentId(incidentId)),
					),
				)
		}

		await trackTokenUsage(env, {
			orgId,
			inputTokens: agentResult.inputTokens,
			outputTokens: agentResult.outputTokens,
			idempotencyKey: runId,
			source: "triage",
		})
	})

	return { status: "completed" }
}

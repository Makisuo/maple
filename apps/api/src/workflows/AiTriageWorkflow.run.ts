/**
 * Headless AI triage workflow logic (heavy import graph lives here, NOT in the
 * thin class shell — see the dynamic import in `AiTriageWorkflow.ts`).
 *
 * Investigates a freshly opened incident (error or anomaly) and persists a
 * structured triage result onto `ai_triage_runs` (+ the error-issue timeline).
 *
 * The LLM investigation runs **in process** on `@maple/llm` (see
 * `./triage-agent.ts`): Cloudflare Workers AI through the `AI` binding, driving
 * the read-only Maple MCP tools directly. It used to run on the Flue `triage`
 * workflow over the `CHAT_FLUE` service binding, which meant a
 * api -> chat-flue -> MCP-over-HTTP -> api round trip and a hand-maintained
 * Valibot mirror of `AiTriageResult`; both are gone.
 *
 * This workflow is unchanged in what it owns: the incident lifecycle
 * (gate/claim, Postgres persistence, issue severity + timeline, Autumn token
 * tracking). Only the "brain" moved.
 *
 * Step layout:
 *   1. gate-and-claim — replay guard, LLM availability check
 *   2. run-agent      — run the investigation (one durable I/O-bound step)
 *                       and map its structured result
 *   3. persist        — run row + issue timeline + usage tracking
 */
import { createHash } from "node:crypto"
import * as MapleCloudflareSDK from "@maple-dev/effect-sdk/cloudflare"
import { aiTriageRuns, anomalyIncidents, errorIssueEvents } from "@maple/db"
import type { MaplePgClient } from "@maple/db/client"
import { ANTICIPATED_ERROR_IDENTIFIERS } from "@maple/domain/anticipated-errors"
import { AiTriageResult } from "@maple/domain/http"
import {
	AiTriageRunId,
	AnomalyIncidentId,
	ErrorIssueEventId,
	ErrorIssueId,
	OrgId,
	UserId,
} from "@maple/domain/primitives"
import { layerFromEnvRecord, WorkerConfigProviderLayer } from "@maple/effect-cloudflare"
import { and, eq } from "drizzle-orm"
import { Cause, Data, Effect, Exit, Layer, ManagedRuntime, Option, Schema } from "effect"
import { trackTokenUsage } from "@/services/billing/autumn-tracker"
import { applyTriageSeverity } from "@/services/errors/issue-severity"
import {
	makeTracedPgConnection,
	type TracedPgConnection,
	tracedPgConnectionFrom,
} from "@/platform/pg-execute"
import { isWorkersAiBinding } from "@/platform/WorkersAiHttpClient"
import type { WorkflowEventLike, WorkflowStepLike } from "./ClickHouseSchemaApplyWorkflow.run"

export interface AiTriageWorkflowEnv extends Record<string, unknown> {
	readonly MAPLE_DB: unknown
	/** Cloudflare Workers AI binding. Keyless + neuron-billed; see `@/platform/WorkersAiHttpClient`. */
	readonly AI?: unknown
	/** REST fallback for stages with no `AI` binding (local `bun dev`, self-hosted). */
	readonly CLOUDFLARE_API_KEY?: string
}

/** Structured result of one investigation, as the durable `run-agent` step sees it. */
interface TriageInvocationResult {
	readonly result: unknown
	readonly model: { readonly provider: string; readonly id: string }
	readonly usage: {
		readonly input: number
		readonly output: number
		readonly cacheRead?: number
	}
}

interface InvokeTriageInput {
	readonly env: AiTriageWorkflowEnv
	readonly orgId: string
	readonly incidentKind: "error" | "anomaly" | "alert"
	readonly incidentId: string
	readonly context: Record<string, unknown>
}

/**
 * True when the worker can reach a model at all: either the Workers AI binding
 * (the keyless, neuron-billed path) or an API key for the REST endpoint.
 */
const canReachModel = (env: AiTriageWorkflowEnv): boolean =>
	isWorkersAiBinding(env.AI) ||
	(typeof env.CLOUDFLARE_API_KEY === "string" && env.CLOUDFLARE_API_KEY !== "")

/** Internal actor the triage tools run as — same identity the internal MCP RPC path uses. */
const internalServiceUserId = Schema.decodeUnknownSync(UserId)("internal-service")

/**
 * Run the investigation in process.
 *
 * The route graph (`../app`) and the Postgres layer are imported dynamically for the same reason
 * `worker.ts` does it: their static graph builds hundreds of Effect Schema ASTs at module scope,
 * which would blow Cloudflare's ~1s startup-CPU budget (error 10021). This module is itself only
 * reached through a dynamic import inside `run()`, so the cost lands inside the workflow step.
 */
const invokeTriageWorkflow = async ({
	env,
	orgId,
	incidentKind,
	context,
}: InvokeTriageInput): Promise<TriageInvocationResult> => {
	if (!canReachModel(env)) throw new Error("llm_unavailable")

	const [{ MainLive }, { layerPg }, { layerLlm, resolveTriageModel }, { runTriageAgent }] =
		await Promise.all([
			import("../app"),
			import("../platform/DatabasePgLive"),
			import("../platform/Llm"),
			import("./triage-agent"),
		])

	const runtime = ManagedRuntime.make(
		MainLive.pipe(
			Layer.provideMerge(layerLlm(env)),
			Layer.provideMerge(layerPg),
			Layer.provideMerge(layerFromEnvRecord(env)),
			Layer.provideMerge(triageTelemetry.layer),
			Layer.provideMerge(WorkerConfigProviderLayer),
		),
	)

	try {
		const output = await runtime.runPromise(
			runTriageAgent({
				orgId,
				incidentKind,
				context,
				model: resolveTriageModel(env),
				tenant: {
					orgId: decodeOrgId(orgId),
					userId: internalServiceUserId,
					roles: [],
					authMode: "self_hosted",
				},
			}),
		)
		return {
			result: output.result,
			model: output.model,
			usage: output.usage,
		}
	} finally {
		await runtime.dispose().catch(() => undefined)
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
/** Validate the agent's result against the canonical domain schema before persisting. */
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
	anticipatedErrorIdentifiers: [...ANTICIPATED_ERROR_IDENTIFIERS],
})

const GATE_STEP = { retries: { limit: 3, delay: "2 seconds", backoff: "exponential" } }
// One retry at most — a retried step re-runs the whole investigation.
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
	/**
	 * Prompt-cache reads. New with `@maple/llm` — Flue had no prompt caching at all, so
	 * this was always effectively zero before. Recorded on the span so the cache hit rate
	 * of the ~21 tool definitions riding in every turn is observable.
	 */
	readonly cacheReadTokens: number
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
	 * Test seam: stub the investigation so the test asserts the persist path without
	 * reaching a model. Production runs `runTriageAgent` in process.
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
	// postgres.js connection it dialed itself. Either way the steps run through
	// `connection.step`, so this workflow's queries produce the same
	// `Database.execute` client spans as the request path.
	const connection =
		deps.db !== undefined
			? tracedPgConnectionFrom(deps.db)
			: makeTracedPgConnection(resolveMapleDbConnectionString(env.MAPLE_DB))
	try {
		return await runAiTriageWithDb(connection, env, event, step, deps)
	} finally {
		await connection.end()
	}
}

async function runAiTriageWithDb(
	connection: TracedPgConnection,
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
	 * One unit of DB work, traced as a `Database.execute` client span on this
	 * module's telemetry layer — the same idiom `logFailure` below uses to reach
	 * OTLP from outside the worker's layer graph. Rejects on failure, so callers
	 * keep their existing try/catch shape.
	 */
	const dbStep = <T>(fn: (db: MaplePgClient) => Promise<T>): Promise<T> =>
		Effect.runPromise(connection.step(fn).pipe(Effect.provide(triageTelemetry.layer)))

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
			await dbStep((db) =>
				db
					.update(aiTriageRuns)
					.set({ status: "failed", error, completedAt: new Date(now), updatedAt: new Date(now) })
					.where(and(eq(aiTriageRuns.orgId, decodeOrgId(orgId)), eq(aiTriageRuns.id, runId))),
			)
			if (incidentKind === "anomaly") {
				await dbStep((db) =>
					db
						.update(anomalyIncidents)
						.set({ triageStatus: "skipped", updatedAt: new Date(now) })
						.where(
							and(
								eq(anomalyIncidents.orgId, decodeOrgId(orgId)),
								eq(anomalyIncidents.id, decodeAnomalyIncidentId(incidentId)),
							),
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
		const rows = await dbStep((db) =>
			db.select().from(aiTriageRuns).where(eq(aiTriageRuns.id, runId)).limit(1),
		)
		const run = rows[0]
		// Replay guard: a re-delivered event for a run that already progressed is
		// a no-op (statuses other than queued mean another execution owns it).
		if (!run || run.status !== "queued") {
			return { proceed: false as const, contextJson: {} }
		}

		// No Workers AI binding and no API key means there is no model to reach —
		// fail the run explicitly rather than let the agent step time out.
		if (!canReachModel(env)) {
			return { proceed: false as const, failure: "llm_unavailable", contextJson: run.contextJson }
		}

		const now = clock()
		await dbStep((db) =>
			db
				.update(aiTriageRuns)
				.set({ status: "running", startedAt: new Date(now), updatedAt: new Date(now) })
				.where(eq(aiTriageRuns.id, runId)),
		)

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

			// The investigation now runs in this worker, so `runTriageAgent` emits its
			// own `ai_triage.investigate` span underneath this one. This span keeps the
			// aggregate token counts and the resolved model for correlation.
			const generateExit = await Effect.runPromiseExit(
				Effect.tryPromise({
					try: () => invokeTriage({ env, orgId, incidentKind, incidentId, context }),
					catch: (error) => new TriageGenerateError({ cause: error }),
				}).pipe(
					Effect.tap((r) =>
						Effect.annotateCurrentSpan({
							"gen_ai.usage.input_tokens": r.usage.input,
							"gen_ai.usage.output_tokens": r.usage.output,
							"gen_ai.usage.cache_read_input_tokens": r.usage.cacheRead ?? 0,
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
			const invocation = generateExit.value
			// `generateObject` already decoded against `AiTriageResult`, but the seam is
			// typed `unknown` (a test stub can return anything) and this is the last
			// checkpoint before the value reaches the DB.
			const decoded = decodeTriageResult(invocation.result)

			return {
				resultJson: JSON.stringify(decoded),
				model: invocation.model.id,
				inputTokens: invocation.usage.input,
				outputTokens: invocation.usage.output,
				cacheReadTokens: invocation.usage.cacheRead ?? 0,
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
		await dbStep((db) =>
			db
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
				.where(and(eq(aiTriageRuns.orgId, decodeOrgId(orgId)), eq(aiTriageRuns.id, runId))),
		)

		if (issueId) {
			// Any linked issue (error fingerprint, alert-backed, or anomaly-linked)
			// gets the triage outcome applied: severity (respecting manual
			// override) + timeline events + escalation outbox. All writes are
			// idempotent via runId-derived deterministic ids, so a retried persist
			// step cannot duplicate them.
			const result = decodeTriageResultJson(agentResult.resultJson)
			const applied = await dbStep((db) =>
				applyTriageSeverity(db, {
					orgId: decodeOrgId(orgId),
					issueId: decodeIssueId(issueId),
					runId,
					severity: result.severityAssessment,
					confidence: result.confidence,
					timestamp: now,
					result,
				}),
			)
			await dbStep((db) =>
				db
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
					.onConflictDoNothing(),
			)
		}

		if (incidentKind === "anomaly") {
			await dbStep((db) =>
				db
					.update(anomalyIncidents)
					.set({ triageStatus: "completed", updatedAt: new Date(now) })
					.where(
						and(
							eq(anomalyIncidents.orgId, decodeOrgId(orgId)),
							eq(anomalyIncidents.id, decodeAnomalyIncidentId(incidentId)),
						),
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

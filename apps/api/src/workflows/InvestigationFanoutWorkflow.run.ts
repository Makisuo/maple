/**
 * Planned investigation workflow logic (heavy import graph lives here, NOT in
 * the thin class shell — see the dynamic import in `InvestigationFanoutWorkflow.ts`).
 *
 * Step layout:
 *   1. claim           — replay guard, fix the deadlines
 *   2. plan            — scope the incident, write hypotheses, seed one lane each
 *   3. hypothesis-<n>  — N concurrent evidence passes, one per hypothesis
 *   4. validate        — rank the candidates, promote at most one (SKIPPED when the plan collapsed)
 *   5. seed-transcript — reconstruct a readable thread in the chat session
 *   6. persist         — publish the diagnosis, or record that nothing held
 *
 * Rules the workflow engine imposes, each of which has bitten somebody:
 *
 * - **Clocks are read inside steps, never in the body.** A `Date.now()` in the
 *   workflow body returns something different on every replay, which silently
 *   invalidates every cached step result downstream of it. Both deadlines are
 *   computed once inside `claim` and ride out on its cached result.
 * - **A lane step never rejects.** Its body is a total try/catch and the promise
 *   carries a second `.catch`. If a step exhausted its retries and threw,
 *   `Promise.all` would reject and kill the whole instance — which is exactly the
 *   "one slow lane loses the entire investigation" outcome the design forbids.
 * - **Step names never derive from model output.** Lanes are named by *ordinal*,
 *   so the alphabet is `{hypothesis-0 … hypothesis-4}` no matter what the planner
 *   writes. The ordinal→hypothesis mapping is read back from the rows `plan`
 *   wrote, which is the same discipline `validate` uses: read lanes from
 *   Postgres, not from step return values, because a step whose result was lost
 *   to a retry boundary still wrote its row.
 *
 * On the rename from `lens-<lensId>`: an in-flight instance replays cached steps
 * against redeployed code, so renaming a step orphans its cache and re-bills the
 * pass. That is accepted here rather than guarded, because the fan-out shipped
 * behind `ai_triage_settings.fanout_enabled`, which defaulted false and had no
 * write path anywhere in the codebase — no instance has ever run in production.
 * A version-branch would be a duplicate of this whole file guarding a case that
 * cannot exist. A v1 payload that somehow arrives simply re-runs from `plan`.
 */
import * as MapleCloudflareSDK from "@maple-dev/effect-sdk/cloudflare"
import { investigationLensRuns, investigations } from "@maple/db"
import type { MaplePgClient } from "@maple/db/client"
import { ANTICIPATED_ERROR_IDENTIFIERS } from "@maple/domain/anticipated-errors"
import {
	AiTriageResult,
	InvestigationPlan,
	InvestigationSubject,
	InvestigationSubjectSnapshot,
	type IssueSeverity,
	type LensVerdict,
} from "@maple/domain/http"
import { InvestigationId, OrgId, UserId } from "@maple/domain/primitives"
import { layerFromEnvRecord, WorkerConfigProviderLayer } from "@maple/effect-cloudflare"
import { randomUUID } from "node:crypto"
import { and, eq, sql } from "drizzle-orm"
import { Effect, Layer, ManagedRuntime, Option, Schema } from "effect"
import { applyDiagnosisWrites } from "@/services/errors/apply-diagnosis"
import type { TenantContext } from "@/services/auth/tenant-context"
import { trackTokenUsage } from "@/services/billing/autumn-tracker"
import {
	makeTracedPgConnection,
	type TracedPgConnection,
	tracedPgConnectionFrom,
} from "@/platform/pg-execute"
import type { WorkflowEventLike, WorkflowStepLike } from "./ClickHouseSchemaApplyWorkflow.run"
import { normalizePlan, widthFor, type PlannedHypothesis } from "./plan-normalize"

export interface InvestigationFanoutWorkflowEnv extends Record<string, unknown> {
	readonly MAPLE_DB: unknown
	readonly CHAT_SESSION?: unknown
	readonly OPENROUTER_API_KEY?: string
	readonly AI?: unknown
	readonly CLOUDFLARE_API_KEY?: string
}

export interface InvestigationFanoutWorkflowPayload {
	readonly orgId: string
	readonly investigationId: string
	/**
	 * Ceiling on hypotheses, from severity and incident kind at enqueue time. The
	 * planner may return fewer; it may not return more.
	 */
	readonly maxWidth: number
	/** Restart counter, so a retry gets a distinct workflow instance id. */
	readonly attempt: number
	/**
	 * Passes the caller reserved against the daily budget before the planner ran.
	 * `plan` reconciles the difference downward once the real width is known.
	 */
	readonly reservedPasses: number
}

export interface InvestigationFanoutWorkflowResult {
	readonly status: "ranked" | "inconclusive" | "skipped" | "failed"
}

const decodeOrgId = Schema.decodeUnknownSync(OrgId)
const decodeInvestigationId = Schema.decodeUnknownSync(InvestigationId)
const decodeSubject = Schema.decodeUnknownSync(InvestigationSubject)
const decodeSnapshotOption = Schema.decodeUnknownOption(InvestigationSubjectSnapshot)
const decodePlanOption = Schema.decodeUnknownOption(InvestigationPlan)
const decodeReport = Schema.decodeUnknownSync(AiTriageResult)

/** Internal actor the lane tools run as — same identity the internal MCP RPC path uses. */
const internalServiceUserId = Schema.decodeUnknownSync(UserId)("internal-service")

/**
 * Wall-clock for the planning pass. Short because planning is scoping: four
 * rounds of tool calls against tools that answer quickly.
 */
const PLAN_BUDGET_MS = 2 * 60 * 1000

/**
 * Wall-clock for the evidence-gathering phase, after planning. Lanes check it
 * between turns and spend a final step submitting what they have rather than
 * being cut off, so this bounds the *gathering*, not the pass.
 *
 * Two minutes longer than the old single lens budget, because a lane now arrives
 * with a specific claim and real tools rather than a framing. Total gathering
 * window is `PLAN_BUDGET_MS + HYPOTHESIS_BUDGET_MS` = 8 minutes, comfortably
 * inside the 25-minute stale sweep with room for the validator.
 */
const HYPOTHESIS_BUDGET_MS = 6 * 60 * 1000

/** Hard ceiling on lanes, and therefore on the alphabet of step names. */
const MAX_HYPOTHESES = 5

const CLAIM_STEP = { retries: { limit: 3, delay: "2 seconds", backoff: "exponential" } } as const
// One retry at most, here and below — a retried pass re-runs a whole model call.
const PLAN_STEP = { retries: { limit: 1, delay: "5 seconds" }, timeout: "4 minutes" } as const
const HYPOTHESIS_STEP = { retries: { limit: 1, delay: "5 seconds" }, timeout: "10 minutes" } as const
const VALIDATE_STEP = { retries: { limit: 1, delay: "5 seconds" }, timeout: "5 minutes" } as const
const PERSIST_STEP = { retries: { limit: 5, delay: "2 seconds", backoff: "exponential" } } as const

const fanoutTelemetry = MapleCloudflareSDK.make({
	serviceName: "maple-api",
	serviceNamespace: "backend",
	repositoryUrl: "https://github.com/Makisuo/maple",
	anticipatedErrorIdentifiers: [...ANTICIPATED_ERROR_IDENTIFIERS],
})

/**
 * One runtime for the whole instance, built lazily and shared by every step.
 *
 * The dynamic-import gymnastics in this file and in `turn-runner.ts` exist
 * because building `MainLive` constructs hundreds of Schema ASTs and blows
 * Cloudflare's startup-CPU budget (error 10021). Building five of them
 * concurrently, one per lane step, would take that cost and multiply it against
 * a 30s per-step CPU limit — so the lane steps share one.
 */
const makeRuntime = async (env: InvestigationFanoutWorkflowEnv) => {
	const [{ MainLive }, { layerPg }, { layerLlm }] = await Promise.all([
		import("../app"),
		import("../platform/DatabasePgLive"),
		import("../platform/Llm"),
	])
	return ManagedRuntime.make(
		MainLive.pipe(
			Layer.provideMerge(layerLlm(env)),
			Layer.provideMerge(layerPg),
			Layer.provideMerge(layerFromEnvRecord(env)),
			Layer.provideMerge(fanoutTelemetry.layer),
			Layer.provideMerge(WorkerConfigProviderLayer),
		),
	)
}

type SharedRuntime = Awaited<ReturnType<typeof makeRuntime>>

// ---------------------------------------------------------------------------
// Planner
// ---------------------------------------------------------------------------

export interface InvokePlannerInput {
	readonly env: InvestigationFanoutWorkflowEnv
	readonly orgId: string
	readonly investigationId: string
	readonly subject: unknown
	readonly snapshot: unknown
	readonly deadlineAtMs: number
	readonly runtime: SharedRuntime
}

export interface InvokePlannerOutput {
	/** Null when the planner never submitted; `normalizePlan` falls back to seeds. */
	readonly plan: unknown | null
	readonly model: string
	readonly inputTokens: number
	readonly outputTokens: number
	readonly toolCount: number
}

const invokePlanner = async (input: InvokePlannerInput): Promise<InvokePlannerOutput> => {
	const [{ runPlannerAgent }, { resolveTriageModel }] = await Promise.all([
		import("./planner-agent"),
		import("../platform/Llm"),
	])
	const output = await input.runtime.runPromise(
		runPlannerAgent({
			investigationId: input.investigationId,
			subject: decodeSubject(input.subject),
			snapshot: snapshotOrNull(input.snapshot),
			// The strong model. One pass decides how the whole run is spent: a bad plan
			// wastes every lane downstream of it, which is far more expensive than the
			// difference between the two tiers.
			model: resolveTriageModel(input.env, {
				surface: "ai-triage",
				orgId: input.orgId,
				sessionId: `inv_${input.investigationId}`,
			}),
			tenant: tenantFor(input.orgId),
			deadlineAtMs: input.deadlineAtMs,
		}),
	)
	return {
		plan: Option.getOrNull(output.plan),
		model: output.model,
		inputTokens: output.usage.input,
		outputTokens: output.usage.output,
		toolCount: output.toolSteps,
	}
}

// ---------------------------------------------------------------------------
// Hypothesis lanes
// ---------------------------------------------------------------------------

/** What a lane step reports back to the workflow body. Deliberately small. */
export interface HypothesisStepResult {
	readonly hypothesisId: string
	readonly status: "reported" | "no_finding"
	readonly toolCount: number
	readonly elapsedMs: number
	readonly inputTokens: number
	readonly outputTokens: number
}

export interface InvokeHypothesisInput {
	readonly env: InvestigationFanoutWorkflowEnv
	readonly orgId: string
	readonly investigationId: string
	readonly hypothesis: PlannedHypothesis
	readonly scopeSummary: string
	readonly subject: unknown
	readonly snapshot: unknown
	readonly deadlineAtMs: number
	/** True on the collapsed path: answer with a full diagnosis, not a candidate. */
	readonly solo: boolean
	readonly runtime: SharedRuntime
}

export interface InvokeHypothesisOutput {
	/** Null when the lane reached no candidate. */
	readonly claim: string | null
	readonly mechanism: string | null
	readonly confidence: "high" | "medium" | "low" | null
	readonly selfDoubt: string | null
	readonly suggestedActions: ReadonlyArray<string>
	readonly evidence: ReadonlyArray<unknown>
	/** Set only on the collapsed path: the report to publish directly. */
	readonly report: unknown | null
	readonly model: string
	readonly inputTokens: number
	readonly outputTokens: number
	readonly toolCount: number
	/**
	 * True when the lane answered because its wall clock ran out, not because it
	 * was done. Carried to the row and into the validator's view of the candidate:
	 * "checked and found nothing" and "ran out of clock" are different reports, and
	 * ranking them the same is how a cut-short lane gets counted as a clean
	 * negative that rules out a rival.
	 */
	readonly deadlineHit: boolean
}

const tenantFor = (orgId: string): TenantContext => ({
	orgId: decodeOrgId(orgId),
	userId: internalServiceUserId,
	roles: [],
	authMode: "self_hosted",
})

const snapshotOrNull = (snapshot: unknown) =>
	decodeSnapshotOption(snapshot).pipe((option) => (option._tag === "Some" ? option.value : null))

const invokeHypothesis = async (input: InvokeHypothesisInput): Promise<InvokeHypothesisOutput> => {
	const [{ runHypothesisAgent, runSoloHypothesisAgent }, { resolveLensModel }] = await Promise.all([
		import("./hypothesis-agent"),
		import("../platform/Llm"),
	])
	const agentInput = {
		investigationId: input.investigationId,
		hypothesis: input.hypothesis,
		scopeSummary: input.scopeSummary,
		subject: decodeSubject(input.subject),
		snapshot: snapshotOrNull(input.snapshot),
		model: resolveLensModel(input.env, {
			surface: "investigation-lens" as const,
			orgId: input.orgId,
			sessionId: `inv_${input.investigationId}`,
		}),
		tenant: tenantFor(input.orgId),
		deadlineAtMs: input.deadlineAtMs,
	}

	if (input.solo) {
		const output = await input.runtime.runPromise(runSoloHypothesisAgent(agentInput))
		const report = Option.getOrNull(output.report)
		return {
			// The collapsed path has no candidate to rank, but the lane row still
			// renders: the claim slot carries the published cause so the Hypotheses tab
			// shows what was tested rather than an empty lane next to a verdict.
			claim: report?.suspectedCause ?? null,
			mechanism: null,
			confidence: report?.confidence ?? null,
			selfDoubt: null,
			suggestedActions: report?.suggestedActions ?? [],
			evidence: report?.evidence ?? [],
			report,
			model: output.model,
			inputTokens: output.usage.input,
			outputTokens: output.usage.output,
			toolCount: output.toolSteps,
			deadlineHit: output.deadlineHit,
		}
	}

	const output = await input.runtime.runPromise(runHypothesisAgent(agentInput))
	// A lane that reached no candidate is a real result, not a failure — the
	// workflow records it as a `no_finding` lane and the validator is told it
	// reported nothing.
	const candidate = Option.getOrUndefined(output.candidate)
	return {
		claim: candidate?.claim ?? null,
		mechanism: candidate?.mechanism ?? null,
		confidence: candidate?.confidence ?? null,
		selfDoubt: candidate?.selfDoubt ?? null,
		suggestedActions: candidate?.suggestedActions ?? [],
		evidence: candidate?.evidence ?? [],
		report: null,
		model: output.model,
		inputTokens: output.usage.input,
		outputTokens: output.usage.output,
		toolCount: output.toolSteps,
		deadlineHit: output.deadlineHit,
	}
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

export interface InvokeValidatorInput {
	readonly env: InvestigationFanoutWorkflowEnv
	readonly orgId: string
	readonly investigationId: string
	readonly subject: unknown
	readonly snapshot: unknown
	readonly candidates: ReadonlyArray<{
		readonly lensId: string
		readonly name: string | null
		readonly claim: string | null
		readonly mechanism: string | null
		readonly confidence: string | null
		readonly selfDoubt: string | null
		readonly suggestedActions: ReadonlyArray<string>
		readonly evidence: ReadonlyArray<unknown>
		readonly note: string | null
		readonly deadlineHit: boolean
	}>
	readonly runtime: SharedRuntime
}

export interface InvokeValidatorOutput {
	readonly promotedLensId: string | null
	readonly report: unknown | null
	readonly rivals: ReadonlyArray<{ lensId: string; verdict: LensVerdict; reason: string }>
	readonly note: string
	readonly model: string
	readonly inputTokens: number
	readonly outputTokens: number
}

const invokeValidator = async (input: InvokeValidatorInput): Promise<InvokeValidatorOutput> => {
	const [{ runValidatorAgent }, { resolveTriageModel }] = await Promise.all([
		import("./validator-agent"),
		import("../platform/Llm"),
	])
	const output = await input.runtime.runPromise(
		runValidatorAgent({
			investigationId: input.investigationId,
			subject: decodeSubject(input.subject),
			snapshot: snapshotOrNull(input.snapshot),
			candidates: input.candidates,
			// The validator runs on the strong model even when lanes run cheap: it
			// does the reasoning the whole fan-out exists to enable.
			model: resolveTriageModel(input.env, {
				surface: "investigation-validator",
				orgId: input.orgId,
				sessionId: `inv_${input.investigationId}`,
			}),
			tenant: tenantFor(input.orgId),
		}),
	)
	return {
		promotedLensId: output.verdict.promotedLensId,
		report: output.verdict.report,
		rivals: output.verdict.rivals.map((rival) => ({
			lensId: rival.lensId,
			verdict: rival.verdict as LensVerdict,
			reason: rival.reason,
		})),
		note: output.verdict.note,
		model: output.model,
		inputTokens: output.usage.input,
		outputTokens: output.usage.output,
	}
}

export interface InvestigationFanoutDeps {
	/** Test seam: swap the database client (e.g. a PGlite-backed drizzle). */
	readonly db?: MaplePgClient
	/** Test seam: stub the planner so tests never reach a model. */
	readonly invokePlanner?: (input: InvokePlannerInput) => Promise<InvokePlannerOutput>
	/** Test seam: stub a hypothesis pass. */
	readonly invokeHypothesis?: (input: InvokeHypothesisInput) => Promise<InvokeHypothesisOutput>
	/** Test seam: stub the ranking. */
	readonly invokeValidator?: (input: InvokeValidatorInput) => Promise<InvokeValidatorOutput>
	/** Test seam: fixed clock for timestamp assertions. */
	readonly now?: () => number
	/** Test seam: skip building the real Effect runtime. */
	readonly makeRuntime?: (env: InvestigationFanoutWorkflowEnv) => Promise<SharedRuntime>
	/** Test seam: observe transcript seeding without a Durable Object. */
	readonly seedTranscript?: (input: SeedTranscriptInput) => Promise<void>
}

export interface SeedTranscriptInput {
	readonly env: InvestigationFanoutWorkflowEnv
	readonly orgId: string
	readonly investigationId: string
	readonly attempt: number
	readonly subject: unknown
	readonly snapshot: unknown
	/** The reconstruction, already fenced. */
	readonly body: string
}

export async function runInvestigationFanout(
	env: InvestigationFanoutWorkflowEnv,
	event: WorkflowEventLike<InvestigationFanoutWorkflowPayload>,
	step: WorkflowStepLike,
	deps: InvestigationFanoutDeps = {},
): Promise<InvestigationFanoutWorkflowResult> {
	const connection =
		deps.db !== undefined
			? tracedPgConnectionFrom(deps.db)
			: makeTracedPgConnection(resolveMapleDbConnectionString(env.MAPLE_DB))
	try {
		return await runWithDb(connection, env, event, step, deps)
	} finally {
		await connection.end()
		await fanoutTelemetry.flush(env).catch(() => undefined)
	}
}

const resolveMapleDbConnectionString = (binding: unknown): string => {
	const value = (binding as { connectionString?: unknown } | undefined)?.connectionString
	if (typeof value !== "string" || value === "") {
		throw new Error("MAPLE_DB binding is missing a connection string")
	}
	return value
}

async function runWithDb(
	connection: TracedPgConnection,
	env: InvestigationFanoutWorkflowEnv,
	event: WorkflowEventLike<InvestigationFanoutWorkflowPayload>,
	step: WorkflowStepLike,
	deps: InvestigationFanoutDeps,
): Promise<InvestigationFanoutWorkflowResult> {
	const clock = deps.now ?? (() => Date.now())
	const { orgId, investigationId, attempt, reservedPasses } = event.payload
	const orgIdTyped = decodeOrgId(orgId)
	const idTyped = decodeInvestigationId(investigationId)

	const dbStep = <T>(fn: (db: MaplePgClient) => Promise<T>): Promise<T> =>
		Effect.runPromise(connection.step(fn).pipe(Effect.provide(fanoutTelemetry.layer)))

	const laneRows = () =>
		dbStep((db) =>
			db
				.select()
				.from(investigationLensRuns)
				.where(
					and(
						eq(investigationLensRuns.investigationId, idTyped),
						eq(investigationLensRuns.attempt, attempt),
					),
				)
				.orderBy(investigationLensRuns.ordinal),
		)

	// ---------------------------------------------------------------- claim
	const claimed = await step.do("claim", CLAIM_STEP, async () => {
		const now = clock()
		const rows = await dbStep((db) =>
			db
				.select()
				.from(investigations)
				.where(and(eq(investigations.orgId, orgIdTyped), eq(investigations.id, idTyped)))
				.limit(1),
		)
		const row = rows[0]
		// Replay guard: only a still-running investigation that has not already been
		// claimed may proceed. A resolved or re-diagnosed row must not be overwritten
		// by a workflow instance that outlived it.
		if (!row || row.status !== "investigating") return { proceed: false as const }
		if (row.fanoutState !== "queued" && row.fanoutState !== "running") {
			return { proceed: false as const }
		}

		// Both deadlines fixed here, once, and returned on the cached result. Reading
		// a clock anywhere downstream of this would differ per replay.
		const planDeadlineAtMs = now + PLAN_BUDGET_MS
		const hypothesisDeadlineAtMs = planDeadlineAtMs + HYPOTHESIS_BUDGET_MS
		await dbStep((db) =>
			db
				.update(investigations)
				.set({
					fanoutState: "running",
					fanoutDeadlineAt: new Date(hypothesisDeadlineAtMs),
					updatedAt: new Date(now),
				})
				.where(and(eq(investigations.orgId, orgIdTyped), eq(investigations.id, idTyped))),
		)

		return {
			proceed: true as const,
			planDeadlineAtMs,
			hypothesisDeadlineAtMs,
			subject: row.subjectJson as unknown,
			snapshot: (row.snapshotJson ?? null) as unknown,
			severity: (row.severity ?? null) as IssueSeverity | null,
			incidentKind: row.incidentKind ?? undefined,
			issueId: row.issueId ?? null,
		}
	})

	if (!claimed.proceed) return { status: "skipped" }

	const runtime = await (deps.makeRuntime ?? makeRuntime)(env)
	try {
		return await runPhases()
	} finally {
		await runtime.dispose?.().catch(() => undefined)
	}

	async function runPhases(): Promise<InvestigationFanoutWorkflowResult> {
		if (!claimed.proceed) return { status: "skipped" }
		const { planDeadlineAtMs, hypothesisDeadlineAtMs, subject, snapshot, issueId } = claimed

		// --------------------------------------------------------------- plan
		const planned = await step.do("plan", PLAN_STEP, async () => {
			const startedAt = clock()
			let output: InvokePlannerOutput
			try {
				output = await (deps.invokePlanner ?? invokePlanner)({
					env,
					orgId,
					investigationId,
					subject,
					snapshot,
					deadlineAtMs: planDeadlineAtMs,
					runtime,
				})
			} catch {
				// A planner that died is a plan we do not have, not a run we abandon.
				// `normalizePlan` turns `None` into the seed catalogue, so the failure
				// degrades to the pre-planner behaviour rather than to no investigation.
				output = { plan: null, model: "", inputTokens: 0, outputTokens: 0, toolCount: 0 }
			}
			const finishedAt = clock()

			const width = Math.min(
				MAX_HYPOTHESES,
				Math.min(event.payload.maxWidth, widthFor(claimed.severity, claimed.incidentKind)),
			)
			const plan = normalizePlan(output.plan === null ? Option.none() : decodePlanOption(output.plan), {
				subject: decodeSubject(subject),
				snapshot: snapshotOrNull(snapshot),
				maxWidth: width,
			})

			// Reconcile the reservation downward. The caller had to reserve before the
			// width was knowable, and it reserved *high* on purpose — under-reserving
			// lets a burst of incidents blow the daily pass budget with no signal.
			const actualPasses = plan.collapsed ? 2 : plan.hypotheses.length + 2
			await dbStep(async (db) => {
				await db
					.update(investigations)
					.set({
						fanoutSize: plan.collapsed ? 1 : plan.hypotheses.length,
						autonomousTurns: sql`greatest(0, ${investigations.autonomousTurns} - ${Math.max(0, reservedPasses - actualPasses)})`,
						planJson: {
							scopeSummary: plan.scopeSummary,
							incidentStartedAt: plan.incidentStartedAt,
							incidentEndedAt: plan.incidentEndedAt,
							hypotheses: plan.hypotheses,
							collapseReason: plan.collapseReason,
						} as never,
						plannerModel: output.model === "" ? null : output.model,
						plannerElapsedMs: finishedAt - startedAt,
						updatedAt: new Date(finishedAt),
					})
					.where(and(eq(investigations.orgId, orgIdTyped), eq(investigations.id, idTyped)))

				for (const [ordinal, hypothesis] of plan.hypotheses.entries()) {
					await db
						.insert(investigationLensRuns)
						.values({
							id: randomUUID(),
							orgId: orgIdTyped,
							investigationId: idTyped,
							attempt,
							lensId: hypothesis.id,
							lensName: hypothesis.name,
							lensQuestion: hypothesis.question,
							priority: hypothesis.priority,
							hypothesisJson: hypothesis as never,
							ordinal,
							status: "queued",
							verdict: "pending",
							createdAt: new Date(finishedAt),
							updatedAt: new Date(finishedAt),
						})
						// The unique index on (investigation_id, attempt, lens_id) makes a
						// replayed plan idempotent rather than growing a second lane each time.
						.onConflictDoNothing()
				}
			})

			return {
				scopeSummary: plan.scopeSummary,
				collapsed: plan.collapsed,
				usedSeedFallback: plan.usedSeedFallback,
				notes: plan.notes,
				hypotheses: plan.hypotheses,
				plannerInputTokens: output.inputTokens,
				plannerOutputTokens: output.outputTokens,
			}
		})

		// -------------------------------------------------------- hypotheses
		// `Promise.all` over `step.do` is genuinely concurrent (verified against the
		// engine before this was written). Every branch is total: a lane that throws
		// becomes a `no_finding` lane, never a failed instance.
		//
		// Named by ordinal, not by hypothesis id: the id is model output, and a step
		// name derived from model output is a step name that changes between the run
		// and its replay.
		const laneResults = await Promise.all(
			planned.hypotheses.map((hypothesis, ordinal) =>
				step
					.do(`hypothesis-${ordinal}`, HYPOTHESIS_STEP, async (): Promise<HypothesisStepResult> => {
						const startedAt = clock()
						await dbStep((db) =>
							db
								.update(investigationLensRuns)
								.set({
									status: "checking",
									progressNote: hypothesis.question,
									startedAt: new Date(startedAt),
									updatedAt: new Date(startedAt),
								})
								.where(
									and(
										eq(investigationLensRuns.investigationId, idTyped),
										eq(investigationLensRuns.attempt, attempt),
										eq(investigationLensRuns.lensId, hypothesis.id),
									),
								),
						)

						try {
							const output = await (deps.invokeHypothesis ?? invokeHypothesis)({
								env,
								orgId,
								investigationId,
								hypothesis,
								scopeSummary: planned.scopeSummary,
								subject,
								snapshot,
								deadlineAtMs: hypothesisDeadlineAtMs,
								solo: planned.collapsed,
								runtime,
							})
							const finishedAt = clock()
							const status = output.claim === null ? "no_finding" : "reported"
							await dbStep((db) =>
								db
									.update(investigationLensRuns)
									.set({
										status,
										claim: output.claim,
										mechanism: output.mechanism,
										progressNote: null,
										confidence: output.confidence,
										toolCount: output.toolCount,
										elapsedMs: finishedAt - startedAt,
										inputTokens: output.inputTokens,
										outputTokens: output.outputTokens,
										model: output.model,
										evidenceJson: output.evidence as never,
										selfDoubt: output.selfDoubt,
										suggestedActionsJson: output.suggestedActions,
										deadlineHit: output.deadlineHit,
										reportedAt: new Date(finishedAt),
										updatedAt: new Date(finishedAt),
									})
									.where(
										and(
											eq(investigationLensRuns.investigationId, idTyped),
											eq(investigationLensRuns.attempt, attempt),
											eq(investigationLensRuns.lensId, hypothesis.id),
										),
									),
							)
							// On the collapsed path the lane's report IS the diagnosis. Stashed on
							// the investigation row rather than returned, because a step result can
							// be lost to a retry boundary while the row survives — the same reason
							// `validate` reads lanes from Postgres.
							if (output.report !== null) {
								await dbStep((db) =>
									db
										.update(investigations)
										.set({
											reportJson: output.report as never,
											updatedAt: new Date(finishedAt),
										})
										.where(
											and(
												eq(investigations.orgId, orgIdTyped),
												eq(investigations.id, idTyped),
											),
										),
								)
							}
							return {
								hypothesisId: hypothesis.id,
								status,
								toolCount: output.toolCount,
								elapsedMs: finishedAt - startedAt,
								inputTokens: output.inputTokens,
								outputTokens: output.outputTokens,
							}
						} catch (error) {
							// A lane that fails is a lane that found nothing, not a dead run.
							const finishedAt = clock()
							const message = error instanceof Error ? error.message : String(error)
							await dbStep((db) =>
								db
									.update(investigationLensRuns)
									.set({
										status: "no_finding",
										progressNote: null,
										error: message.slice(0, 500),
										elapsedMs: finishedAt - startedAt,
										reportedAt: new Date(finishedAt),
										updatedAt: new Date(finishedAt),
									})
									.where(
										and(
											eq(investigationLensRuns.investigationId, idTyped),
											eq(investigationLensRuns.attempt, attempt),
											eq(investigationLensRuns.lensId, hypothesis.id),
										),
									),
							)
							return {
								hypothesisId: hypothesis.id,
								status: "no_finding" as const,
								toolCount: 0,
								elapsedMs: finishedAt - startedAt,
								inputTokens: 0,
								outputTokens: 0,
							}
						}
					})
					// Second belt: if the step itself exhausted its retries and threw,
					// `Promise.all` would otherwise reject and take the instance with it.
					.catch(
						(): HypothesisStepResult => ({
							hypothesisId: hypothesis.id,
							status: "no_finding",
							toolCount: 0,
							elapsedMs: 0,
							inputTokens: 0,
							outputTokens: 0,
						}),
					),
			),
		)
		void laneResults

		// ------------------------------------------------ collapsed: publish
		// No rivals, so no validator. Skipping the step entirely — rather than
		// running one that trivially promotes the only candidate — is the point of
		// collapsing: it saves a full strong-model pass on a comparison with nothing
		// to compare against.
		if (planned.collapsed) {
			return await step.do("persist-collapsed", PERSIST_STEP, async () => {
				const now = clock()
				const lanes = await laneRows()
				const inputTokens =
					lanes.reduce((total, lane) => total + (lane.inputTokens ?? 0), 0) +
					planned.plannerInputTokens
				const outputTokens =
					lanes.reduce((total, lane) => total + (lane.outputTokens ?? 0), 0) +
					planned.plannerOutputTokens
				const rows = await dbStep((db) =>
					db
						.select({ reportJson: investigations.reportJson })
						.from(investigations)
						.where(and(eq(investigations.orgId, orgIdTyped), eq(investigations.id, idTyped)))
						.limit(1),
				)
				const report = rows[0]?.reportJson ?? null
				if (report === null) {
					await dbStep((db) =>
						db
							.update(investigations)
							.set({
								status: "failed",
								fanoutState: "rejected_all",
								error: "collapsed_no_diagnosis: the single hypothesis submitted no report",
								inputTokens,
								outputTokens,
								updatedAt: new Date(now),
							})
							.where(and(eq(investigations.orgId, orgIdTyped), eq(investigations.id, idTyped))),
					)
					await meterTokens(env, orgId, investigationId, attempt, inputTokens, outputTokens)
					return { status: "inconclusive" as const }
				}
				await dbStep(async (db) => {
					await db
						.update(investigationLensRuns)
						.set({
							verdict: "promoted",
							reason: "The only hypothesis planning found worth testing.",
							rankedAt: new Date(now),
							updatedAt: new Date(now),
						})
						.where(
							and(
								eq(investigationLensRuns.investigationId, idTyped),
								eq(investigationLensRuns.attempt, attempt),
							),
						)
					await applyDiagnosisWrites(db, {
						orgId: orgIdTyped,
						investigationId: idTyped,
						report: decodeReport(report),
						issueId,
						model: lanes[0]?.model ?? null,
						inputTokens,
						outputTokens,
						nowMs: now,
						fanoutState: "ranked",
						validatorNote: "Planning collapsed to one hypothesis; no ranking was needed.",
						validatorElapsedMs: null,
					})
				})
				await meterTokens(env, orgId, investigationId, attempt, inputTokens, outputTokens)
				return { status: "ranked" as const }
			})
		}

		// ----------------------------------------------------------- validate
		// A validator that exhausts its retries used to kill the instance outright:
		// the run ended with N passes consumed and NOTHING metered or written,
		// because tokens are only ever reported from `persist`. The lanes really
		// ran, so their cost is real whether or not anything ranked them.
		let verdict: Awaited<ReturnType<typeof runValidateStep>>
		try {
			verdict = await runValidateStep()
		} catch (error) {
			await step.do("validate-failed", PERSIST_STEP, async () => {
				const now = clock()
				const lanes = await laneRows()
				const inputTokens =
					lanes.reduce((total, lane) => total + (lane.inputTokens ?? 0), 0) +
					planned.plannerInputTokens
				const outputTokens =
					lanes.reduce((total, lane) => total + (lane.outputTokens ?? 0), 0) +
					planned.plannerOutputTokens
				await dbStep((db) =>
					db
						.update(investigations)
						.set({
							status: "failed",
							fanoutState: "rejected_all",
							error: `validation_failed: ${error instanceof Error ? error.message : String(error)}`.slice(
								0,
								500,
							),
							inputTokens,
							outputTokens,
							updatedAt: new Date(now),
						})
						.where(and(eq(investigations.orgId, orgIdTyped), eq(investigations.id, idTyped))),
				)
				await meterTokens(env, orgId, investigationId, attempt, inputTokens, outputTokens)
				return { metered: inputTokens + outputTokens }
			})
			return { status: "failed" }
		}

		async function runValidateStep() {
			return await step.do("validate", VALIDATE_STEP, async () => {
				const startedAt = clock()
				await dbStep((db) =>
					db
						.update(investigations)
						.set({ fanoutState: "validating", updatedAt: new Date(startedAt) })
						.where(and(eq(investigations.orgId, orgIdTyped), eq(investigations.id, idTyped))),
				)

				// Read the lanes back from Postgres rather than from the step results: a
				// step whose *return value* was lost to a retry boundary still wrote its row.
				const lanes = await laneRows()

				const output = await (deps.invokeValidator ?? invokeValidator)({
					env,
					orgId,
					investigationId,
					subject,
					snapshot,
					candidates: lanes.map((lane) => ({
						lensId: lane.lensId,
						name: lane.lensName,
						claim: lane.claim,
						mechanism: lane.mechanism,
						confidence: lane.confidence,
						selfDoubt: lane.selfDoubt,
						suggestedActions: (lane.suggestedActionsJson ?? []) as ReadonlyArray<string>,
						evidence: (lane.evidenceJson ?? []) as ReadonlyArray<unknown>,
						note: lane.error,
						deadlineHit: lane.deadlineHit,
					})),
					runtime,
				})

				const finishedAt = clock()
				const byLens = new Map(output.rivals.map((rival) => [rival.lensId, rival]))
				await dbStep(async (db) => {
					for (const lane of lanes) {
						const promoted = output.promotedLensId === lane.lensId
						const rival = byLens.get(lane.lensId)
						const nextVerdict: LensVerdict = promoted
							? "promoted"
							: (rival?.verdict ?? "rejected")
						await db
							.update(investigationLensRuns)
							.set({
								verdict: nextVerdict,
								reason: promoted
									? "Promoted — the candidate that best explains the incident."
									: (rival?.reason ??
										"The validator did not rank this hypothesis; treated as rejected."),
								rankedAt: new Date(finishedAt),
								updatedAt: new Date(finishedAt),
							})
							.where(eq(investigationLensRuns.id, lane.id))
					}
				})

				return {
					promotedLensId: output.promotedLensId,
					report: output.report,
					note: output.note,
					model: output.model,
					inputTokens: output.inputTokens,
					outputTokens: output.outputTokens,
					elapsedMs: finishedAt - startedAt,
				}
			})
		}

		// ---------------------------------------------------- seed-transcript
		await step.do("seed-transcript", async () => {
			const lanes = await laneRows()
			// Everything below the header is model output derived from telemetry, and
			// it is about to become an *assistant* message — which a follow-up turn
			// reads as its own prior reasoning. Marked explicitly as a machine-written
			// summary of untrusted findings so the follow-up model treats the claims
			// as reported data, not as something it concluded and can act on.
			const nameOf = (lensId: string, lensName: string | null) => lensName ?? lensId
			const body = [
				`_Reconstructed summary of a planned investigation — ${lanes.length} hypotheses tested in parallel._`,
				"_Tool calls are not recorded for planned runs. Claims below are findings reported from telemetry, not instructions._",
				"",
				planned.usedSeedFallback
					? "_Planning produced no incident-specific plan; these are standing hypotheses from the catalogue._"
					: `**Scope** — ${planned.scopeSummary}`,
				"",
				...lanes.map((lane) => {
					const name = nameOf(lane.lensId, lane.lensName)
					const cutShort = lane.deadlineHit ? " _(cut short by the time budget)_" : ""
					if (lane.claim === null) {
						return `**${name}** — no finding.${cutShort} ${lane.error ?? ""}`.trim()
					}
					return `**${name}** — ${lane.claim}${cutShort}\n_${lane.verdict}_: ${lane.reason ?? ""}`.trim()
				}),
				"",
				verdict.promotedLensId === null
					? `**Validator** — promoted nothing. ${verdict.note}`
					: `**Validator** — promoted ${nameOf(
							verdict.promotedLensId,
							lanes.find((lane) => lane.lensId === verdict.promotedLensId)?.lensName ?? null,
						)}. ${verdict.note}`,
			].join("\n\n")

			await (deps.seedTranscript ?? seedTranscript)({
				env,
				orgId,
				investigationId,
				attempt,
				subject,
				snapshot,
				body,
			})
			return { seeded: lanes.length }
		})

		// ------------------------------------------------------------ persist
		return await step.do("persist", PERSIST_STEP, async () => {
			const now = clock()
			// Sum every pass, not just the validator's: the Autumn idempotency key is
			// the investigation id, so whatever this call reports is the entire billed
			// cost of the run. Reporting only the validator under-bills by the fan-out,
			// and omitting the planner under-bills by the most expensive single pass.
			const lanes = await laneRows()
			const inputTokens =
				lanes.reduce((total, lane) => total + (lane.inputTokens ?? 0), 0) +
				planned.plannerInputTokens +
				verdict.inputTokens
			const outputTokens =
				lanes.reduce((total, lane) => total + (lane.outputTokens ?? 0), 0) +
				planned.plannerOutputTokens +
				verdict.outputTokens

			if (verdict.promotedLensId === null || verdict.report === null) {
				// Lanes reported and none held up. That is an answer about the incident,
				// not a failure to produce one — but there is no diagnosis to publish.
				await dbStep((db) =>
					db
						.update(investigations)
						.set({
							status: "failed",
							fanoutState: "rejected_all",
							error: `validation_inconclusive: ${verdict.note}`,
							validatorNote: verdict.note,
							validatorElapsedMs: verdict.elapsedMs,
							model: verdict.model,
							inputTokens,
							outputTokens,
							updatedAt: new Date(now),
						})
						.where(and(eq(investigations.orgId, orgIdTyped), eq(investigations.id, idTyped))),
				)
				await meterTokens(env, orgId, investigationId, attempt, inputTokens, outputTokens)
				return { status: "inconclusive" as const }
			}

			await dbStep((db) =>
				applyDiagnosisWrites(db, {
					orgId: orgIdTyped,
					investigationId: idTyped,
					report: decodeReport(verdict.report),
					issueId,
					model: verdict.model,
					inputTokens,
					outputTokens,
					nowMs: now,
					fanoutState: "ranked",
					validatorNote: verdict.note,
					validatorElapsedMs: verdict.elapsedMs,
				}),
			)
			await meterTokens(env, orgId, investigationId, attempt, inputTokens, outputTokens)
			return { status: "ranked" as const }
		})
	}
}

const meterTokens = async (
	env: InvestigationFanoutWorkflowEnv,
	orgId: string,
	investigationId: string,
	attempt: number,
	inputTokens: number,
	outputTokens: number,
): Promise<void> => {
	if (!inputTokens && !outputTokens) return
	// Metering must never fail the run — the diagnosis is the product, the meter is
	// bookkeeping.
	//
	// The key carries the attempt. Keyed on the bare investigation id, a restart
	// reused attempt 1's key and its real, different spend was deduplicated away —
	// every retry after the first was free. Within one attempt the key is still
	// stable, so a retried `persist` bills once.
	await trackTokenUsage(env, {
		orgId: decodeOrgId(orgId),
		inputTokens,
		outputTokens,
		idempotencyKey: `${investigationId}:${attempt}`,
		source: "triage",
	}).catch(() => undefined)
}

/**
 * Reconstruct a readable thread in the investigation's chat session.
 *
 * A planned run never touches the Durable Object, so without this the Transcript
 * tab is empty — and worse, a follow-up in the Chat tab gets investigate-mode
 * instructions with no first message to ground them. This is a reconstruction,
 * not a recording: individual tool calls are not in it.
 */
const seedTranscript = async (input: SeedTranscriptInput): Promise<void> => {
	if (!input.env.CHAT_SESSION) return
	const [
		{ chatSessionStub },
		{ wrapChatContext },
		{ AUTONOMOUS_KICKOFF_LEAD, buildIncidentContextMessage },
	] = await Promise.all([
		import("../chat/session"),
		import("@maple/domain/chat-preamble"),
		import("./incident-context"),
	])
	const sessionId = `${input.orgId}:inv-${input.investigationId}`
	const stub = chatSessionStub(input.env as Record<string, unknown>, sessionId)
	if (!stub) return

	// Deterministic, so a retried step is a no-op rather than a second copy of the
	// whole thread.
	const messageId = `fanout-${input.investigationId}-${input.attempt}`

	try {
		const existing = await stub.history()
		if (existing.some((event) => "messageId" in event && event.messageId === messageId)) return

		// The same fenced first message the single-pass path sends, so a follow-up
		// turn is grounded exactly as it would be on the other path.
		await stub.append({
			type: "user-message",
			id: `${messageId}-subject`,
			text: wrapChatContext(
				buildIncidentContextMessage(
					AUTONOMOUS_KICKOFF_LEAD,
					decodeSubject(input.subject),
					snapshotOrNull(input.snapshot),
				),
				"",
			),
		})
		await stub.append({ type: "turn-start", messageId })
		await stub.append({ type: "text-delta", messageId, text: input.body })
		await stub.append({ type: "turn-end", messageId, reason: "stop" })
	} catch {
		// A transcript we could not seed is a cosmetic loss; the diagnosis stands.
	}
}

/**
 * Handing a freshly-inserted investigation to the Cloudflare Workflow that runs
 * its fan-out.
 *
 * Two producers reach this — `maybeEnqueueTriage` (an incident opened) and
 * `enqueueFixVerification` (a PR merged) — and they had grown byte-for-byte
 * copies of the same sixty lines: the binding shape check, the `markFailed`
 * update, the `Exit`-wrapped `create()`, and the span annotations the tick reads
 * back. Including two separate declarations of `isFanoutWorkflowBinding`.
 *
 * What is genuinely different between them stays with them: the subject, the
 * snapshot, and the insert. Those encode what the run is *about*. Starting it
 * does not.
 */
import { Effect, Exit } from "effect"
import { eq } from "drizzle-orm"
import { investigations } from "@maple/db"
import type { InvestigationId, OrgId } from "@maple/domain/primitives"
import { Database, type DatabaseError } from "@/platform/DatabaseLive"
import { summarizeCause } from "@/platform/describe-cause"
import { FanoutStartError } from "@/services/errors/investigation-fanout-error"

export interface FanoutWorkflowBinding {
	readonly create: (options: { id: string; params: unknown }) => Promise<{ id: string }>
}

export const isFanoutWorkflowBinding = (value: unknown): value is FanoutWorkflowBinding =>
	typeof value === "object" &&
	value !== null &&
	typeof (value as { create?: unknown }).create === "function"

export interface StartFanoutInput {
	readonly orgId: OrgId
	readonly investigationId: InvestigationId
	readonly maxWidth: number
	readonly reservedPasses: number
	readonly nowMs: number
	/** The Workflow binding, straight off the worker env. Absent outside a Worker. */
	readonly fanoutBinding: unknown
	/**
	 * Extra span attributes to merge into every outcome annotation. The
	 * verification path adds `maple.verification.id`, because the tick reads the
	 * start outcome back and can answer `no_binding` with a terminal verdict —
	 * without the id, the trace of that auto-close says nothing about which
	 * verification it closed.
	 */
	readonly annotations?: Record<string, string>
}

export type StartFanoutResult =
	| { readonly started: true }
	| { readonly started: false; readonly reason: "no_binding" | "error" }

/**
 * Start the fan-out, or mark the investigation failed and say why.
 *
 * There is deliberately no chat-session fallback: a run that was planned and
 * then quietly executed as one shallow pass is a lie in the boards, so a missing
 * binding records the reason and stops.
 */
export const startInvestigationFanout: (
	input: StartFanoutInput,
) => Effect.Effect<StartFanoutResult, DatabaseError, Database> = Effect.fn("startInvestigationFanout")(
	function* (input) {
		const database = yield* Database
		const { orgId, investigationId, maxWidth, reservedPasses, nowMs } = input
		const annotations = input.annotations ?? {}

		const markFailed = (error: string) =>
			database
				.execute((db) =>
					db
						.update(investigations)
						.set({ status: "failed", error, updatedAt: new Date(nowMs) })
						.where(eq(investigations.id, investigationId)),
				)
				.pipe(Effect.asVoid)

		const workflow = input.fanoutBinding
		if (!isFanoutWorkflowBinding(workflow)) {
			yield* markFailed(
				"agent_unavailable: the investigation fan-out workflow is not configured; retry",
			)
			yield* Effect.annotateCurrentSpan({
				orgId,
				"maple.investigation.id": investigationId,
				"maple.investigation.start_result": "no_binding",
				...annotations,
			})
			return { started: false, reason: "no_binding" as const }
		}

		// Persist the instance id BEFORE dispatch, exactly as the manual start path
		// does. Without it every automatically created investigation kept a null
		// `workflowInstanceId`, and `restartInvestigation` — which terminates the
		// prior instance only when the column is populated — left the old workflow
		// running to publish over the replacement attempt. Attempt 0's instance id
		// is deterministic: the bare investigation id.
		yield* database
			.execute((db) =>
				db
					.update(investigations)
					.set({ workflowInstanceId: investigationId, updatedAt: new Date(nowMs) })
					.where(eq(investigations.id, investigationId)),
			)
			.pipe(Effect.asVoid)

		// `Exit`, not `Effect.option`: the reason a create() failed is the whole
		// diagnostic value here — an id collision means a live instance already owns
		// this investigation, a network error means retry.
		const created = yield* Effect.exit(
			Effect.tryPromise({
				try: () =>
					workflow.create({
						id: investigationId,
						params: { orgId, investigationId, maxWidth, reservedPasses, attempt: 0 },
					}),
				catch: FanoutStartError.fromCause,
			}),
		)
		if (Exit.isFailure(created)) {
			yield* Effect.logWarning("Investigation fan-out could not be started").pipe(
				Effect.annotateLogs({
					orgId,
					investigationId,
					error: summarizeCause(created.cause),
				}),
			)
			yield* markFailed("start_failed: the investigation fan-out could not be started; retry")
			yield* Effect.annotateCurrentSpan({
				orgId,
				"maple.investigation.id": investigationId,
				"maple.investigation.start_result": "start_failed",
				...annotations,
			})
			return { started: false, reason: "error" as const }
		}

		yield* Effect.annotateCurrentSpan({
			orgId,
			"maple.investigation.id": investigationId,
			"maple.investigation.start_result": "fanout_started",
			"maple.investigation.fanout_max_width": String(maxWidth),
			...annotations,
		})
		return { started: true as const }
	},
)

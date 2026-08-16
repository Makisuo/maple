/**
 * What a chat turn is allowed to call.
 *
 * Kept out of `loop/` on purpose: the loop's job is to decide *when* to call a tool and what to do
 * with the result, not to know which tools exist. Swapping the tool set — a read-only sub-agent, a
 * mode with narrower reach — should not touch the control flow at all.
 */
import { investigationIdFromChatSessionId } from "@maple/domain/chat-session"
import { evaluatePermission, type PermissionRuleset } from "@maple/domain/permission"
import {
	AiTriageResult,
	InvestigationDataCorruptionError,
	InvestigationNotFoundError,
	InvestigationPersistenceError,
	SubmitDiagnosisRequest,
} from "@maple/domain/http"
import { InvestigationId, UserId } from "@maple/domain/primitives"
import { Tool, ToolFailure, type Model, type Tools } from "@maple/llm"
import { Effect, Option, Schema } from "effect"
import type { McpToolExecutorApi, McpToolSurface } from "@/mcp/dispatcher"
import { buildMapleTools, summarizeToolFailure } from "@/mcp/tools/llm-tools"
import type { TenantContext } from "@/services/auth/tenant-context"
import type { TurnCompletion, TurnUsage } from "./loop/types"

const decodeInvestigationIdOption = Schema.decodeUnknownOption(InvestigationId)

/**
 * The `submit_diagnosis` tool for an investigate-mode session (`"<orgId>:inv-<id>"`).
 *
 * The agent calls it exactly once at the end of its autonomous pass and its arguments ARE the
 * structured report — `AiTriageResult` directly, not the Valibot mirror `apps/chat-flue` had to
 * keep in sync by hand.
 *
 * Deliberately not approval-gated: it is the structured-output channel, not a user-facing
 * mutation. The investigation id and org ride from the session id, so the agent never chooses
 * which investigation it writes.
 *
 * `submitDiagnosis` arrives as a callback rather than being resolved from `InvestigationService`
 * here: that service is itself what starts an investigation's autonomous turn, so resolving it
 * through the Effect requirements channel would make `InvestigationService` require itself.
 */
export type SubmitDiagnosis = (
	orgId: TenantContext["orgId"],
	investigationId: InvestigationId,
	request: SubmitDiagnosisRequest,
) => Effect.Effect<
	unknown,
	InvestigationPersistenceError | InvestigationNotFoundError | InvestigationDataCorruptionError
>

/**
 * The user id every machine-started turn runs as.
 *
 * An investigation's own autonomous pass is claimed by `InvestigationService` under this actor; a
 * human opening the same session and asking a follow-up is not. That difference is what decides
 * whether the diagnosis tool merely exists or is the turn's *answer* — see below.
 */
const INTERNAL_SERVICE_USER_ID = Schema.decodeSync(UserId)("internal-service")

export const buildDiagnosisCompletion = (
	sessionId: string,
	tenant: TenantContext,
	submitDiagnosis: SubmitDiagnosis,
	usage: TurnUsage,
	model: Model,
): TurnCompletion | undefined => {
	const rawId = investigationIdFromChatSessionId(sessionId)
	if (!rawId) return undefined
	// `decodeUnknownSync` here turned a session id whose `inv-` suffix was not a UUID into a thrown
	// defect on a user-supplied string. An unparseable id simply means this conversation is not an
	// investigation, so it gets no `submit_diagnosis` tool.
	const decoded = decodeInvestigationIdOption(rawId)
	if (Option.isNone(decoded)) return undefined
	const investigationId = decoded.value
	const tool = Tool.make({
		description:
			"Record your structured diagnosis for THIS investigation. Call it exactly once, " +
			"after you have gathered evidence, with your final assessment. It persists the report " +
			"and renders it for the user. After calling it, stop unless the user asks a follow-up.",
		parameters: AiTriageResult,
		success: Schema.String,
		execute: (report) =>
			submitDiagnosis(
				tenant.orgId,
				investigationId,
				new SubmitDiagnosisRequest({
					report,
					model: String(model.id),
					inputTokens: usage.input,
					outputTokens: usage.output,
				}),
			).pipe(
				Effect.as("Diagnosis recorded."),
				// Named failures only. `catchCause` + `String(cause)` fed the model a rendered
				// Effect cause — stack frames, and connection details out of a DatabaseError.
				Effect.catchCause((cause) =>
					Effect.fail(
						new ToolFailure({
							message: `submit_diagnosis failed: ${summarizeToolFailure(cause)}`,
						}),
					),
				),
			),
	})
	return {
		name: "submit_diagnosis",
		tool,
		/**
		 * The autonomous pass answers *through* this tool, so its turn has to close on it: it is the
		 * only thing that writes `investigations.diagnosis`, and a pass that spends its 14 steps
		 * gathering evidence and then hits the tool-less closing step files nothing at all. Supplying
		 * the tool without saying so is exactly what this session did before the two facts became one
		 * value — the report existed as a tool the model could call and as nothing the loop would ever
		 * insist on.
		 *
		 * A human follow-up in the same session gets the same tool and `closes: false`. It *may* file
		 * a superseding diagnosis (the `superseded` status exists for that), but "what did you mean by
		 * the pool?" must be answerable in prose — forcing the close there would rewrite the report
		 * every time someone asked a question about it.
		 */
		closes: tenant.userId === INTERNAL_SERVICE_USER_ID,
	}
}

/**
 * All Maple tools, with mutating ones gated.
 *
 * A gated tool still carries a real handler (rather than being omitted) so the schema the model
 * sees is identical to the read-only case — but the loop never dispatches it, because it breaks on
 * the proposal first, and `POST /internal/chat/apply` remains the only path that actually mutates.
 */
export const buildChatTools = (
	executor: McpToolExecutorApi,
	tenant: TenantContext,
	ruleset: PermissionRuleset,
	surface: McpToolSurface = "chat",
): Tools =>
	buildMapleTools(executor, tenant, {
		surface,
		// `deny` means the model never sees the tool. That is a stronger guarantee than refusing the
		// call afterwards, and it is free — an unoffered tool cannot be called.
		include: (name) => evaluatePermission(ruleset, name) !== "deny",
		gate: (name) => evaluatePermission(ruleset, name) === "ask",
	})

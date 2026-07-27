import { defineTool, type ToolDefinition } from "@flue/runtime"
import type { ChatFlueEnv } from "./env.ts"
import { AiTriageResultSchema, type AiTriageResult } from "./triage-result.ts"
import { mapleApiRpc } from "./api-rpc.ts"

/** Marker the `submit_diagnosis` tool returns; the web renders it as the report card. */
export const DIAGNOSIS_STATUS = "diagnosis" as const

export type DiagnosisMarker = {
	status: typeof DIAGNOSIS_STATUS
	report: AiTriageResult
}

/**
 * The local `submit_diagnosis` tool for an investigate-mode session. The agent
 * calls it once at the end of its diagnostic pass; its args ARE the structured
 * report. The tool POSTs the report to apps/api (which persists the
 * investigation row + applies the issue-side severity/timeline effects) and
 * returns a render marker the web turns into the inline report card.
 *
 * Deliberately NOT routed through `applyApprovalGates`: it is the
 * structured-output channel, not a user-facing mutation, so it executes
 * autonomously without an approval card (mirrors the legacy `submit_triage`).
 * The investigation id and org ride server-side from the session instance id —
 * the agent never chooses which investigation it writes.
 */
export const buildSubmitDiagnosisTool = (
	env: ChatFlueEnv,
	orgId: string,
	investigationId: string,
): ToolDefinition =>
	defineTool({
		name: "submit_diagnosis",
		description:
			"Record your structured diagnosis for THIS investigation. Call it exactly once, after you have gathered evidence, with your final assessment (summary, suspectedCause, severityAssessment, affectedScope, evidence, suggestedActions, confidence). It persists the report and renders it for the user. After calling it, stop unless the user asks a follow-up question.",
		input: AiTriageResultSchema,
		output: undefined,
		run: async ({ input }): Promise<DiagnosisMarker> => {
			await mapleApiRpc(env).submitDiagnosis({ orgId, investigationId, report: input })
			return { status: DIAGNOSIS_STATUS, report: input }
		},
	}) as ToolDefinition

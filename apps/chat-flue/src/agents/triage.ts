"use agent"

import {
	defineTool,
	useAgentStart,
	useDataWriter,
	useInitialData,
	useModel,
	useResponseFinish,
	useTool,
} from "@flue/runtime"
import type { InternalMcpToolDescriptor } from "@maple/domain/internal-rpc"
import * as v from "valibot"
import { buildMapleTools, fetchMapleToolDescriptors } from "../lib/mcp.ts"
import { telemetryEnv } from "../lib/telemetry-env.ts"
import { buildTriageContextMessage, TRIAGE_SYSTEM_PROMPT, TRIAGE_TOOL_NAMES } from "../lib/triage-prompt.ts"
import { AiTriageResultSchema } from "../lib/triage-result.ts"

/**
 * Headless AI-triage — the agentic-investigation half of the legacy apps/api
 * `AiTriageWorkflow`. It runs the read-only investigation loop on Workers AI
 * against Maple's MCP tools and reports a structured `AiTriageResult`.
 *
 * Boundary: this agent owns ONLY the LLM step. The durable incident lifecycle —
 * gate/claim, Postgres persistence, issue severity + timeline, Autumn token
 * tracking — stays in apps/api's AiTriageService, which drives this agent over
 * the `@flue/sdk` conversation client and persists what comes back. That keeps
 * @maple/db, severity logic, and billing out of the worker bundle.
 *
 * Flue 2 deleted `defineWorkflow`, so the shape changed: the payload is now
 * instance-creation data (`Triage.initialData`, validated once before anything
 * durable is admitted), the structured report travels as a named data part
 * (`useDataWriter`), and model/token facts ride on the reply's metadata. See
 * `apps/api/src/workflows/AiTriageWorkflow.run.ts` for the reading side.
 */

const DEFAULT_TRIAGE_MODEL = "cloudflare/@cf/moonshotai/kimi-k2.6"

/** The data part carrying the report. Must match apps/api's reader. */
export const TRIAGE_RESULT_PART = "triage_result"

/** Validated at the instance boundary — the payload arrives from apps/api. */
export const TriagePayloadSchema = v.object({
	orgId: v.string(),
	incidentKind: v.picklist(["error", "anomaly", "alert"]),
	incidentId: v.string(),
	/** Incident context blob written at enqueue time (formatted, never re-queried). */
	context: v.record(v.string(), v.unknown()),
})

export type TriagePayload = v.InferOutput<typeof TriagePayloadSchema>

/**
 * Reply metadata contract, consumed by apps/api's `runFlueTriage`. Declared
 * explicitly rather than inferred: Flue's `PromptUsage` carries more than
 * apps/api reads (cache tokens, cost), and pinning the shape is what keeps the
 * two sides from drifting silently.
 */
export const TriageMetadataSchema = v.object({
	model: v.object({ provider: v.string(), id: v.string() }),
	usage: v.object({ input: v.number(), output: v.number() }),
})

const env = await telemetryEnv()

/** Registry cache — deployment-static, see `src/agents/maple-chat.ts`. */
let descriptorCache: readonly InternalMcpToolDescriptor[] | undefined

/** `"cloudflare/@cf/moonshotai/kimi-k2.6"` → `{ provider: "cloudflare", id: "@cf/…" }`. */
const splitModelSpecifier = (specifier: string): { provider: string; id: string } => {
	const separator = specifier.indexOf("/")
	return separator === -1
		? { provider: "", id: specifier }
		: { provider: specifier.slice(0, separator), id: specifier.slice(separator + 1) }
}

export function Triage() {
	const payload = useInitialData<TriagePayload>()
	const model = env.MAPLE_TRIAGE_MODEL ?? env.MAPLE_CHAT_MODEL ?? DEFAULT_TRIAGE_MODEL

	useModel(model)

	const writeResult = useDataWriter(TRIAGE_RESULT_PART, { schema: AiTriageResultSchema })

	// Aggregate usage across the whole investigation loop — strictly more
	// complete than v1, which reported only the single structured prompt.
	useResponseFinish(({ response }) => ({
		model: splitModelSpecifier(model),
		usage: { input: response.usage.input, output: response.usage.output },
	}))

	// The investigation is read-only, so the allowlist is the whole tool surface
	// this agent may touch. An unknown name here is a hard error by design.
	useAgentStart(async () => {
		descriptorCache ??= await fetchMapleToolDescriptors(env)
	})

	if (descriptorCache) {
		for (const tool of buildMapleTools(env, payload.orgId, descriptorCache, {
			allowlist: TRIAGE_TOOL_NAMES,
		})) {
			useTool(tool)
		}
	}

	// Replaces v1's `{ result }` prompt option: the model ends its investigation
	// by calling this once, which validates the report, publishes it as the
	// `triage_result` data part, and ends the turn.
	useTool(
		defineTool({
			name: "submit_triage",
			description:
				"Record your final structured triage report. Call it exactly once, after you have gathered evidence. This ends the investigation.",
			input: AiTriageResultSchema,
			output: undefined,
			run: ({ data }) => {
				writeResult(data)
				return { terminate: true }
			},
		}),
	)

	return `${TRIAGE_SYSTEM_PROMPT}\n\n${buildTriageContextMessage(payload.incidentKind, payload.context)}`
}

Triage.agentName = "triage"
Triage.initialData = TriagePayloadSchema

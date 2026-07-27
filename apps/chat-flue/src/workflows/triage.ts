import { defineAgent, defineWorkflow, type WorkflowRouteHandler } from "@flue/runtime"
import * as v from "valibot"
import type { ChatFlueEnv } from "../lib/env.ts"
import { connectMapleMcp } from "../lib/mcp.ts"
import { telemetryEnv } from "../lib/telemetry-env.ts"
import { buildTriageContextMessage, TRIAGE_SYSTEM_PROMPT, TRIAGE_TOOL_NAMES } from "../lib/triage-prompt.ts"
import { AiTriageResultSchema } from "../lib/triage-result.ts"

/**
 * Headless AI-triage as a Flue workflow — the agentic-investigation half of the
 * legacy apps/api `AiTriageWorkflow`. It runs the read-only investigation loop on
 * Workers AI against Maple's MCP tools and returns a structured `AiTriageResult`.
 *
 * Boundary: this workflow owns ONLY the LLM step. The durable incident lifecycle
 * — gate/claim, Postgres persistence, issue severity + timeline, Autumn token
 * tracking — stays in apps/api's AiTriageService, which invokes this workflow
 * (`@flue/sdk` `workflows.invoke("triage", { input, wait: "result" })`) for the
 * investigation and persists the returned result. This keeps @maple/db, severity
 * logic, and billing out of the worker bundle.
 *
 * Flue's `{ result }` mechanism replaces the legacy `submit_triage` tool: the
 * model's final structured output is validated against `AiTriageResultSchema`.
 */

const DEFAULT_TRIAGE_MODEL = "cloudflare/@cf/moonshotai/kimi-k2.6"

/** Validated at the workflow boundary — the payload arrives over HTTP from apps/api. */
export const TriagePayloadSchema = v.object({
	orgId: v.string(),
	incidentKind: v.picklist(["error", "anomaly", "alert"]),
	incidentId: v.string(),
	/** Incident context blob written at enqueue time (formatted, never re-queried). */
	context: v.record(v.string(), v.unknown()),
})

export type TriagePayload = v.InferOutput<typeof TriagePayloadSchema>

/**
 * The workflow's result contract, consumed by `apps/api`'s `AiTriageWorkflow`
 * (`runFlueTriage`). Declared explicitly rather than inferred from the prompt
 * response: Flue's `PromptModel`/`PromptUsage` carry more than apps/api reads,
 * and an output schema is what keeps the two sides from drifting silently.
 */
export const TriageResultSchema = v.object({
	result: AiTriageResultSchema,
	model: v.object({ provider: v.string(), id: v.string() }),
	usage: v.object({ input: v.number(), output: v.number() }),
})

/** Exposes the workflow at `POST /workflows/triage`. apps/api gates access upstream. */
export const route: WorkflowRouteHandler = async (_c, next) => next()

const triageAgent = defineAgent<ChatFlueEnv>(({ env }) => ({
	model: env.MAPLE_TRIAGE_MODEL ?? env.MAPLE_CHAT_MODEL ?? DEFAULT_TRIAGE_MODEL,
	instructions: TRIAGE_SYSTEM_PROMPT,
}))

export default defineWorkflow({
	agent: triageAgent,
	input: TriagePayloadSchema,
	output: TriageResultSchema,

	async run({ harness, input }) {
		// A workflow's run context carries no bindings, so reach the ambient Worker
		// env for the `MAPLE_API_RPC` binding the MCP adapter calls through. Tools
		// are org-scoped, so they are built per run and scoped to this one prompt
		// rather than baked into the shared agent definition.
		const env = await telemetryEnv()
		const maple = await connectMapleMcp(env, input.orgId, { allowlist: TRIAGE_TOOL_NAMES })
		try {
			const session = await harness.session()
			const { data, usage, model } = await session.prompt(
				buildTriageContextMessage(input.incidentKind, input.context),
				{ result: AiTriageResultSchema, tools: maple.tools },
			)
			return {
				result: data,
				model: { provider: model.provider, id: model.id },
				usage: { input: usage.input, output: usage.output },
			}
		} finally {
			await maple.close()
		}
	},
})

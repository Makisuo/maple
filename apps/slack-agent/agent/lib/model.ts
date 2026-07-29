/**
 * The Workers AI model the agent runs on.
 *
 * Lives here rather than inline in `agent/agent.ts` because two places need
 * the same answer: the agent definition itself, and AI-usage reporting
 * (`agent/lib/token-usage.ts`), which stamps the model on every usage report.
 * eve's `step.completed` event carries token counts but no model id, so the
 * reporter has to resolve it the same way the agent did — and a drift between
 * the two would mis-attribute spend to a model that never ran.
 */

/** Must support tool calling **while streaming** — eve's harness is tool-driven and always streams. */
export const DEFAULT_WORKERS_AI_MODEL = "@cf/zai-org/glm-5.2"

/** Read at call time, not module load, so a var set after import still counts. */
export function workersAiModelId(): string {
	const raw = process.env.WORKERS_AI_MODEL
	return raw && raw.length > 0 ? raw : DEFAULT_WORKERS_AI_MODEL
}
